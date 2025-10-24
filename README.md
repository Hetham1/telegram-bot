# Simple Telegram Bot

A minimal Telegram bot with yes/no questions, admin panel, daily scheduling, and JSON logging.

## 🚀 Quick Deploy (One-Liner)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/telegram-bot.git
git push -u origin main
```

### 2. Deploy to VPS (One Command)
```bash
# Method 1: Pass token directly (recommended for piped install)
BOT_TOKEN='your_bot_token_here' bash <(curl -sSL https://raw.githubusercontent.com/Hetham1/telegram-bot/main/install.sh)

# Method 2: Download and run (allows interactive prompt)
curl -sSL https://raw.githubusercontent.com/Hetham1/telegram-bot/main/install.sh -o install.sh
chmod +x install.sh
./install.sh
```

Replace `your_bot_token_here` with your actual bot token from @BotFather.

### 3. Start the Bot
```bash
cd ~/telegram-bot
./manage_bot.sh start
./manage_bot.sh enable  # Auto-start on boot
```

## ✨ Features

- **Daily Messages**: Automatically sends questions at 12:00 PM Tehran time
- **User Flow**: Yes/No buttons with retry logic
- **Hidden Admin**: Access admin panel with secret code (no security risk for regular users)
- **Statistics**: Daily analytics with `/stats`
- **JSON Logging**: All responses logged with timestamps
- **Admin Notifications**: Get notified when users select "Yes"

## 🎯 How to Use

### For Regular Users:
1. Send `/start` to the bot
2. Answer the daily question
3. That's it! They'll receive a daily message at 12 PM Tehran time

### For Admins (Hidden):
1. Send `/start` to the bot
2. **Type the admin code:** `Admin2024` (just send this text)
3. You're now an admin! You'll see available commands
4. You won't receive daily questions

### Admin Commands:
- `/admin` - Show admin panel with buttons
- `/stats` - View today's statistics
- `/logs` - View all log dates
- `/users` - Manage users and roles
- `/exit` - Exit admin mode (become regular user)

**Note:** Regular users won't know about the admin code. It's completely hidden!

## 🔧 Management (VPS)

```bash
./manage_bot.sh start     # Start bot
./manage_bot.sh stop      # Stop bot
./manage_bot.sh restart   # Restart bot
./manage_bot.sh status    # Check status
./manage_bot.sh logs      # View logs
./manage_bot.sh enable    # Auto-start on boot
```

## 🧪 Local Testing

```powershell
# Windows
$env:BOT_TOKEN="your_token"; python bot.py

# Linux/Mac
export BOT_TOKEN="your_token"
python bot.py
```

## ⏰ Daily Schedule

- **Time**: 12:00 PM (noon)
- **Timezone**: Asia/Tehran
- **Frequency**: Every day
- **Recipients**: All regular users (not admins)

## 📊 Log Format

All responses are stored in `bot_logs.json`:
```json
{
  "2025-01-15": {
    "total_responses": 5,
    "yes_responses": 3,
    "no_responses": 2,
    "users": {
      "123456": {
        "username": "@user",
        "yes_count": 2,
        "no_count": 1
      }
    },
    "responses": [
      {
        "timestamp": "2025-01-15T10:30:00",
        "user_id": 123456,
        "username": "@user",
        "response": "yes"
      }
    ]
  }
}
```

## 👥 User Management

As an admin, you can:
- **View all users**: See list of admins and regular users with statistics
- **Make users admin**: Promote regular users to admin status
- **Remove admin**: Demote admins back to regular users
- **Manage yourself**: You can exit admin mode anytime with `/exit`

### How to manage users:
1. Send `/users` command
2. Click "➕ Make User Admin" or "➖ Remove Admin"
3. Send the user ID when prompted
4. Done! Changes are saved automatically

User IDs are visible in the `/users` list.

## 📁 Files

- `bot.py` - Main bot code with scheduling and user management
- `requirements.txt` - Python dependencies (includes pytz for timezone)
- `install.sh` - VPS installer
- `.gitignore` - Protects sensitive files
- `bot_users.json` - User roles database (auto-generated, in .gitignore)
- `README.md` - This file

## 🐛 Troubleshooting

**Bot not responding:**
```bash
./manage_bot.sh logs  # Check for errors
./manage_bot.sh restart
```

**Check if daily messages are working:**
```bash
./manage_bot.sh logs | grep "daily"
```

**Change admin code:**
Edit `bot.py` and change `self.admin_code = "admin2024"` to your preferred code.

## ⚙️ Requirements

- Python 3.13+
- python-telegram-bot[ext,jobqueue] >=22.0
- pytz (for Tehran timezone)
- Ubuntu VPS (for deployment)

## 🔒 Security

- `.gitignore` protects `.env` and `bot_logs.json`
- Never commit your bot token
- Admin code is hidden from regular users
- No security prompts or hints about admin access

## 🎨 Customization

### Change Admin Code:
Edit line 45 in `bot.py`:
```python
self.admin_code = "your_secret_code_here"
```

### Change Daily Message Time:
Edit line 367 in `bot.py`:
```python
time=time(hour=12, minute=0, second=0),  # Change hour here
```

### Change Question Text:
Edit line 338 in `bot.py`:
```python
text="Your custom question here?",
```

---

**Ready to deploy! Get your bot token from [@BotFather](https://t.me/botfather) and run the one-liner!** 🎉