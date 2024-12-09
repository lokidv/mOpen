const express = require("express");
const ovpn = require("./ovpn");
const checkPassword = require("./middleware/checkPassword");

async function bootstrap() {
  const app = express();
  app.use(express.json());
  app.use(checkPassword);

  app.use("/", ovpn);

  // Ensure the server starts listening
  app.listen(process.env.PORT || 3000, () => {
    console.log("Server is running");
  });
}

bootstrap();

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});
