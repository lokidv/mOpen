const express = require("express");

const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

const app = express.Router();

const CLIENTS_DIR = "/etc/openvpn/clients";

if (!fs.existsSync(CLIENTS_DIR)) {
  fs.mkdirSync(CLIENTS_DIR, { recursive: true });
}

// Determine if we use tls-auth or tls-crypt
function getTLSSig() {
  try {
    const serverConf = fs.readFileSync("/etc/openvpn/server.conf", "utf8");
    if (/^tls-crypt/m.test(serverConf)) {
      return "1";
    } else if (/^tls-auth/m.test(serverConf)) {
      return "2";
    }
  } catch (error) {
    console.error("Error reading /etc/openvpn/server.conf");
    return null;
  }
}

app.get("/create", (req, res) => {
  const client = req.query.publicKey;

  if (!client || !/^[a-zA-Z0-9_-]+$/.test(client)) {
    return res.status(400).json({
      error: "Invalid client name. Alphanumeric, underscore, dash only.",
    });
  }

  let clientExists = false;
  try {
    const output = execSync(
      `tail -n +2 /etc/openvpn/easy-rsa/pki/index.txt | grep -c -E "/CN=${client}$"`,
      { encoding: "utf8" }
    );
    clientExists = parseInt(output.trim()) === 1;
    if (clientExists) {
      try {
        process.chdir("/etc/openvpn/easy-rsa/");
        execSync(`./easyrsa --batch revoke "${client}"`, { stdio: "ignore" });
        execSync("EASYRSA_CRL_DAYS=3650 ./easyrsa gen-crl", {
          stdio: "ignore",
        });
        fs.unlinkSync("/etc/openvpn/crl.pem");
        fs.copyFileSync(
          "/etc/openvpn/easy-rsa/pki/crl.pem",
          "/etc/openvpn/crl.pem"
        );
        fs.chmodSync("/etc/openvpn/crl.pem", 0o644);
        execSync(`find ${CLIENTS_DIR} -name "${client}.ovpn" -delete`);
        execSync(`sed -i "/^${client},.*/d" /etc/openvpn/ipp.txt`);
        execSync(
          "cp /etc/openvpn/easy-rsa/pki/index.txt /etc/openvpn/easy-rsa/pki/index.txt.bk"
        );
      } catch (error) {
        console.error("Error revoking client certificate:", error.message);
      }
    }
  } catch (error) {
    // Ignore error
  }

  try {
    execSync(
      `EASYRSA_CERT_EXPIRE=3650 ./easyrsa --batch build-client-full "${client}" nopass`,
      { stdio: "ignore" }
    );
  } catch (error) {
    console.error("Error creating client certificate:", error);
    return res.status(500).json({ error: "Error creating client certificate" });
  }

  const TLS_SIG = getTLSSig();
  if (!TLS_SIG) {
    return res
      .status(500)
      .json({ error: "Could not determine TLS signature method" });
  }

  // Generate the custom client.ovpn
  try {
    const template = fs.readFileSync(
      "/etc/openvpn/client-template.txt",
      "utf8"
    );
    const caCert = fs.readFileSync("/etc/openvpn/ca.crt", "utf8");
    const clientCertFull = fs.readFileSync(
      `/etc/openvpn/easy-rsa/pki/issued/${client}.crt`,
      "utf8"
    );
    const clientCert = clientCertFull.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
    )[0];
    const clientKey = fs.readFileSync(
      `/etc/openvpn/easy-rsa/pki/private/${client}.key`,
      "utf8"
    );
    let tlsSigContent = "";
    if (TLS_SIG === "1") {
      const tlsCryptKey = fs.readFileSync("/etc/openvpn/tls-crypt.key", "utf8");
      tlsSigContent = `<tls-crypt>\n${tlsCryptKey}\n</tls-crypt>`;
    } else if (TLS_SIG === "2") {
      const tlsAuthKey = fs.readFileSync("/etc/openvpn/tls-auth.key", "utf8");
      tlsSigContent =
        "key-direction 1\n<tls-auth>\n" + tlsAuthKey + "\n</tls-auth>";
    }
    const ovpnContent = `${template}
<ca>
${caCert}
</ca>
<cert>
${clientCert}
</cert>
<key>
${clientKey}
</key>
${tlsSigContent}
`;

    const clientConfigPath = path.join(CLIENTS_DIR, `${client}.ovpn`);
    fs.writeFileSync(clientConfigPath, ovpnContent);

    // Send the .ovpn file content as response (Base64 encoded)
    const ovpnFileBase64 = Buffer.from(ovpnContent).toString("base64");

    return res.send(ovpnContent);
  } catch (error) {
    console.error("Error generating client configuration:", error.message);
    return res
      .status(500)
      .json({ error: "Error generating client configuration" });
  }
});

// Revoke an existing client
app.get("/remove", (req, res) => {
  const client = req.query.publicKey;

  if (!client || !/^[a-zA-Z0-9_-]+$/.test(client)) {
    return res.status(400).json({
      error: "Invalid client name. Alphanumeric, underscore, dash only.",
    });
  }

  try {
    process.chdir("/etc/openvpn/easy-rsa/");
    execSync(`./easyrsa --batch revoke "${client}"`, { stdio: "ignore" });
    execSync("EASYRSA_CRL_DAYS=3650 ./easyrsa gen-crl", { stdio: "ignore" });
    fs.unlinkSync("/etc/openvpn/crl.pem");
    fs.copyFileSync(
      "/etc/openvpn/easy-rsa/pki/crl.pem",
      "/etc/openvpn/crl.pem"
    );
    fs.chmodSync("/etc/openvpn/crl.pem", 0o644);
    execSync(`find ${CLIENTS_DIR} -name "${client}.ovpn" -delete`);
    execSync(`sed -i "/^${client},.*/d" /etc/openvpn/ipp.txt`);
    execSync(
      "cp /etc/openvpn/easy-rsa/pki/index.txt /etc/openvpn/easy-rsa/pki/index.txt.bk"
    );

    return res.json({ deleted: true });
  } catch (error) {
    console.error("Error revoking client certificate:", error.message);
    return res.json({ deleted: false });
  }
});

app.get("/list", async (req, res) => {
  try {
    const files = await fs.promises.readdir(CLIENTS_DIR);
    const filenamesWithoutExt = files.map((file) => path.parse(file).name);
    res.json(filenamesWithoutExt);
  } catch (error) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/list/:clientName", (req, res) => {
  const clientName = req.params.clientName;

  if (!clientName || !/^[a-zA-Z0-9_-]+$/.test(clientName)) {
    return res.status(400).json({
      error: "Invalid client name. Alphanumeric, underscore, dash only.",
    });
  }

  const clientConfigPath = path.join(CLIENTS_DIR, `${clientName}.ovpn`);

  if (!fs.existsSync(clientConfigPath)) {
    return res.status(404).json({ error: "Client configuration not found." });
  }

  // Read the client configuration file
  let configContent;
  try {
    configContent = fs.readFileSync(clientConfigPath, "utf8");
  } catch (error) {
    console.error("Error reading client configuration:", error.message);
    return res
      .status(500)
      .json({ error: "Error reading client configuration" });
  }

  res.send(configContent);
});

module.exports = app;
