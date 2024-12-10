const express = require("express");

const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

const app = express.Router();

const CLIENTS_DIR = "/etc/openvpn/clients";

if (!fs.existsSync(CLIENTS_DIR)) {
  fs.mkdirSync(CLIENTS_DIR, { recursive: true });
}

function tunAvailable() {
  return fs.existsSync("/dev/net/tun");
}

// Parse the /etc/os-release file
function parseOSRelease(content) {
  const lines = content.split("\n");
  const result = {};
  lines.forEach((line) => {
    line = line.trim();
    if (line && line.includes("=")) {
      const parts = line.split("=");
      const key = parts[0];
      let value = parts.slice(1).join("=");
      // Remove quotes if any
      value = value.replace(/^"(.*)"$/, "$1");
      result[key] = value;
    }
  });
  return result;
}

// Check the operating system
function checkOS() {
  let OS = "";
  let ID = "";
  let VERSION_ID = "";
  let ID_LIKE = "";

  if (fs.existsSync("/etc/debian_version")) {
    OS = "debian";
    const osRelease = fs.readFileSync("/etc/os-release", "utf8");
    const osInfo = parseOSRelease(osRelease);
    ID = osInfo.ID;
    VERSION_ID = osInfo.VERSION_ID;

    if (ID === "debian" || ID === "raspbian") {
      if (parseFloat(VERSION_ID) < 9) {
        return {
          supported: false,
          message:
            "Your version of Debian is not supported. Please use Debian 9 or newer.",
        };
      }
    } else if (ID === "ubuntu") {
      OS = "ubuntu";
      const MAJOR_UBUNTU_VERSION = parseInt(VERSION_ID.split(".")[0], 10);
      if (MAJOR_UBUNTU_VERSION < 16) {
        return {
          supported: false,
          message:
            "Your version of Ubuntu is not supported. Please use Ubuntu 16.04 or newer.",
        };
      }
    }
  } else if (fs.existsSync("/etc/system-release")) {
    const osRelease = fs.readFileSync("/etc/os-release", "utf8");
    const osInfo = parseOSRelease(osRelease);
    ID = osInfo.ID;
    VERSION_ID = osInfo.VERSION_ID;
    ID_LIKE = osInfo.ID_LIKE;

    if (ID === "fedora" || ID_LIKE === "fedora") {
      OS = "fedora";
    }
    if (["centos", "rocky", "almalinux"].includes(ID)) {
      OS = "centos";
      if (parseInt(VERSION_ID.split(".")[0], 10) < 7) {
        return {
          supported: false,
          message: "Your version of CentOS is not supported.",
        };
      }
    }
    if (ID === "ol") {
      OS = "oracle";
      if (!VERSION_ID.includes("8")) {
        return {
          supported: false,
          message: "Your version of Oracle Linux is not supported.",
        };
      }
    }
    if (ID === "amzn") {
      OS = "amzn";
      if (VERSION_ID !== "2") {
        return {
          supported: false,
          message: "Your version of Amazon Linux is not supported.",
        };
      }
    }
  } else if (fs.existsSync("/etc/arch-release")) {
    OS = "arch";
  } else {
    return {
      supported: false,
      message:
        "Unsupported system. Supported systems are Debian, Ubuntu, Fedora, CentOS, Amazon Linux 2, Oracle Linux 8, or Arch Linux.",
    };
  }

  return { supported: true, OS };
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
    process.chdir("/etc/openvpn/easy-rsa/");
  } catch (error) {
    console.error("Error changing directory to /etc/openvpn/easy-rsa/");
    return res.status(500).json({ error: "Server error" });
  }

  try {
    // Since we cannot provide a password non-interactively, we only support passwordless clients
    execSync(
      `EASYRSA_CERT_EXPIRE=3650 ./easyrsa --batch build-client-full "${client}" nopass`,
      { stdio: "ignore" }
    );
  } catch (error) {
    console.error("Error creating client certificate:", error.message);
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
