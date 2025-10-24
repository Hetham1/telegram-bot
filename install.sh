#!/bin/bash
# One-liner installer for Telegram Bot
# Usage: curl -sSL https://raw.githubusercontent.com/Hetham1/telegram-bot/main/install.sh | bash

set -e  # Exit on any error

echo "=========================================="
echo "   Telegram Bot One-Liner Installer"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${YELLOW}Warning: Running as root. This is not recommended for security reasons.${NC}"
    echo "Consider creating a regular user for the bot."
    echo ""
    # If running as root, don't use sudo
    SUDO_CMD=""
else
    SUDO_CMD="sudo"
fi

# Get the repository URL (you'll need to update this)
REPO_URL="https://github.com/Hetham1/telegram-bot.git"
INSTALL_DIR="$HOME/telegram-bot"

echo -e "${GREEN}Step 1: Installing system dependencies...${NC}"
${SUDO_CMD} apt update -y
${SUDO_CMD} apt install -y python3 python3-pip python3-venv git curl

echo ""
echo -e "${GREEN}Step 2: Cloning repository...${NC}"
if [ -d "$INSTALL_DIR" ]; then
    echo "Directory already exists. Removing old installation..."
    rm -rf "$INSTALL_DIR"
fi

# Clone the repository
git clone "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo ""
echo -e "${GREEN}Step 3: Setting up Python environment...${NC}"
python3 -m venv bot_env
source bot_env/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo ""
echo -e "${GREEN}Step 4: Configuring bot...${NC}"
echo "Please enter your bot token from @BotFather:"
read -p "BOT_TOKEN: " BOT_TOKEN_INPUT

# Create .env file
cat > .env <<EOF
# Telegram Bot Configuration
BOT_TOKEN=$BOT_TOKEN_INPUT
EOF

# Make scripts executable
chmod +x bot.py

echo ""
echo -e "${GREEN}Step 5: Creating systemd service...${NC}"
BOT_USER=$(whoami)
BOT_DIR=$(pwd)

${SUDO_CMD} tee /etc/systemd/system/telegram-bot.service > /dev/null <<EOF
[Unit]
Description=Telegram Bot Service
After=network.target

[Service]
Type=simple
User=$BOT_USER
WorkingDirectory=$BOT_DIR
Environment=PATH=$BOT_DIR/bot_env/bin
ExecStart=$BOT_DIR/bot_env/bin/python $BOT_DIR/bot.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Create management script
cat > manage_bot.sh <<'EOFMGMT'
#!/bin/bash
# Telegram Bot Management Script

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    SUDO_CMD=""
else
    SUDO_CMD="sudo"
fi

case "$1" in
    start)
        echo "Starting Telegram Bot..."
        ${SUDO_CMD} systemctl start telegram-bot
        ${SUDO_CMD} systemctl status telegram-bot
        ;;
    stop)
        echo "Stopping Telegram Bot..."
        ${SUDO_CMD} systemctl stop telegram-bot
        ;;
    restart)
        echo "Restarting Telegram Bot..."
        ${SUDO_CMD} systemctl restart telegram-bot
        ${SUDO_CMD} systemctl status telegram-bot
        ;;
    status)
        ${SUDO_CMD} systemctl status telegram-bot
        ;;
    logs)
        ${SUDO_CMD} journalctl -u telegram-bot -f
        ;;
    enable)
        echo "Enabling Telegram Bot to start on boot..."
        ${SUDO_CMD} systemctl enable telegram-bot
        ;;
    disable)
        echo "Disabling Telegram Bot from starting on boot..."
        ${SUDO_CMD} systemctl disable telegram-bot
        ;;
    *)
        echo "Telegram Bot Management Script"
        echo "Usage: $0 {start|stop|restart|status|logs|enable|disable}"
        echo ""
        echo "Commands:"
        echo "  start   - Start the bot service"
        echo "  stop    - Stop the bot service"
        echo "  restart - Restart the bot service"
        echo "  status  - Show bot service status"
        echo "  logs    - Show bot logs (live)"
        echo "  enable  - Enable bot to start on boot"
        echo "  disable - Disable bot from starting on boot"
        exit 1
        ;;
esac
EOFMGMT

chmod +x manage_bot.sh

# Reload systemd and enable service
${SUDO_CMD} systemctl daemon-reload
${SUDO_CMD} systemctl enable telegram-bot

echo ""
echo -e "${GREEN}=========================================="
echo "   Installation Complete!"
echo "==========================================${NC}"
echo ""
echo "Bot installed in: $INSTALL_DIR"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Start your bot:"
echo "   cd $INSTALL_DIR"
echo "   ./manage_bot.sh start"
echo ""
echo "2. Check bot status:"
echo "   ./manage_bot.sh status"
echo ""
echo "3. View logs:"
echo "   ./manage_bot.sh logs"
echo ""
echo "4. Enable auto-start on boot:"
echo "   ./manage_bot.sh enable"
echo ""
echo -e "${GREEN}Bot Commands on Telegram:${NC}"
echo "  /start - Normal user flow"
echo "  Admin Code: Admin2024 (type after /start)"
echo "  /admin - Admin panel with buttons"
echo "  /stats - View statistics (admin)"
echo "  /logs - View log dates (admin)"
echo "  /users - Manage users (admin)"
echo ""
echo -e "${GREEN}Management Commands:${NC}"
echo "  ./manage_bot.sh {start|stop|restart|status|logs|enable|disable}"
echo ""
echo "Happy botting! :)"
