sudo apt update
sudo apt install -y curl

# Add NodeSource repo (for latest LTS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -

# Install Node.js
sudo apt install -y nodejs
