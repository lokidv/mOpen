#!/usr/bin/env bash

# Ask the user for the application port
read -p "Enter the port for the Node.js Express app (default: 3000): " PORT
PORT=${PORT:-3000}

# Ask for the API_PASSWORD
read -s -p "Enter API_PASSWORD (no default, required): " API_PASSWORD
echo
if [ -z "$API_PASSWORD" ]; then
  echo "API_PASSWORD cannot be empty."
  exit 1
fi


# Export the PORT as an environment variable for future use
export PORT
export API_PASSWORD

# Install required dependencies for running the script
sudo apt-get update -y
sudo apt-get install -y curl git

# Run the OpenVPN install script
curl -O https://raw.githubusercontent.com/angristan/openvpn-install/master/openvpn-install.sh
chmod +x openvpn-install.sh
./openvpn-install.sh

# Install Node.js LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pm2 globally
sudo npm install pm2@latest -g

# Clone a Node.js Express application repository (Replace with your actual repo)
git clone https://github.com/username/express-app.git /opt/express-app
cd /opt/express-app

# Install dependencies
npm install

# Write out the environment variables to /etc/environment so they persist
{
  echo "PORT=${PORT}"
  echo "API_PASSWORD=${API_PASSWORD}"
} | sudo tee -a /etc/environment > /dev/null

# Reload environment variables
source /etc/environment

# Start the Express app using PM2
# Assuming the main entry point is app.js or server.js
pm2 start ./src/app.js --name "express-app" --env "production"

# Save the PM2 process list for startup on reboot
pm2 save

echo "Setup complete."
echo "OpenVPN installation done, and Node.js Express app is running on port $PORT."
echo "Use 'pm2 list' to manage your PM2 processes."
