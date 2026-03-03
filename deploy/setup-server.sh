#!/bin/bash
# ============================================
# Restaurant Admin Hub - Server Setup Script
# Run this on a fresh Ubuntu 22.04/24.04 VPS
# ============================================
set -e

DOMAIN="cfalarambla.com"
APP_DIR="/opt/pto-tracker"

echo "========================================="
echo "Restaurant Admin Hub - Server Setup"
echo "========================================="

# 1. System updates
echo "[1/7] Updating system..."
apt update && apt upgrade -y

# 2. Install Node.js 20
echo "[2/7] Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs build-essential

# 3. Install PM2
echo "[3/7] Installing PM2..."
npm install -g pm2

# 4. Install Nginx
echo "[4/7] Installing Nginx..."
apt install -y nginx

# 5. Create app directory
echo "[5/7] Setting up application directory..."
mkdir -p $APP_DIR/data
chown -R $USER:$USER $APP_DIR

echo "[6/7] Configuring Nginx..."
cat > /etc/nginx/sites-available/pto-tracker << 'NGINX'
server {
    listen 80;
    server_name cfalarambla.com www.cfalarambla.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 10M;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/pto-tracker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# 7. Install Certbot for SSL
echo "[7/7] Installing SSL certificate..."
apt install -y certbot python3-certbot-nginx
certbot --nginx -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN --redirect

# Enable firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo ""
echo "========================================="
echo "Server setup complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Upload your app to $APP_DIR"
echo "2. cd $APP_DIR && npm install --production"
echo "3. Create .env file with production secrets"
echo "4. npm run setup  (creates admin account)"
echo "5. pm2 start ecosystem.config.js"
echo "6. pm2 save && pm2 startup"
echo ""
