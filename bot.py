#!/usr/bin/env python3
"""
Simple Telegram Bot - Compatible version with daily scheduling
"""

import logging
import os
import json
import pytz
from datetime import datetime, date, time
import telegram
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters

# Configure logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Load environment variables
def load_env():
    """Load environment variables from .env file"""
    try:
        if os.path.exists('.env'):
            with open('.env', 'r') as f:
                for line in f:
                    if line.strip() and not line.startswith('#'):
                        key, value = line.strip().split('=', 1)
                        os.environ[key] = value
    except Exception as e:
        logger.warning(f"Could not load .env file: {e}")

load_env()

# Bot configuration
BOT_TOKEN = os.getenv('BOT_TOKEN')

class SimpleBot:
    def __init__(self):
        self.user_states = {}
        self.admin_users = set()
        self.regular_users = set()  # Track regular users for daily messages
        self.log_file = 'bot_logs.json'
        self.users_file = 'bot_users.json'
        self.admin_code = "Admin2024"  # Hidden admin code
        self.ensure_log_file()
        self.load_users()
    
    def ensure_log_file(self):
        """Create log file if it doesn't exist"""
        if not os.path.exists(self.log_file):
            with open(self.log_file, 'w') as f:
                json.dump({}, f)
    
    def load_users(self):
        """Load users from file"""
        try:
            if os.path.exists(self.users_file):
                with open(self.users_file, 'r') as f:
                    data = json.load(f)
                    self.admin_users = set(data.get('admins', []))
                    self.regular_users = set(data.get('regular_users', []))
                    logger.info(f"Loaded {len(self.admin_users)} admins and {len(self.regular_users)} regular users")
        except Exception as e:
            logger.error(f"Failed to load users: {e}")
    
    def save_users(self):
        """Save users to file"""
        try:
            data = {
                'admins': list(self.admin_users),
                'regular_users': list(self.regular_users)
            }
            with open(self.users_file, 'w') as f:
                json.dump(data, f, indent=2)
            logger.info("Users saved successfully")
        except Exception as e:
            logger.error(f"Failed to save users: {e}")
    
    def log_response(self, user_id, username, response, timestamp=None):
        """Log user response to JSON file"""
        if timestamp is None:
            timestamp = datetime.now().isoformat()
        
        today = date.today().isoformat()
        
        try:
            with open(self.log_file, 'r') as f:
                logs = json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            logs = {}
        
        if today not in logs:
            logs[today] = {
                'date': today,
                'total_responses': 0,
                'yes_responses': 0,
                'no_responses': 0,
                'users': {},
                'responses': []
            }
        
        logs[today]['total_responses'] += 1
        if response == 'yes':
            logs[today]['yes_responses'] += 1
        else:
            logs[today]['no_responses'] += 1
        
        if user_id not in logs[today]['users']:
            logs[today]['users'][str(user_id)] = {
                'username': username,
                'total_responses': 0,
                'yes_count': 0,
                'no_count': 0
            }
        
        logs[today]['users'][str(user_id)]['total_responses'] += 1
        if response == 'yes':
            logs[today]['users'][str(user_id)]['yes_count'] += 1
        else:
            logs[today]['users'][str(user_id)]['no_count'] += 1
        
        response_entry = {
            'timestamp': timestamp,
            'user_id': user_id,
            'username': username,
            'response': response
        }
        logs[today]['responses'].append(response_entry)
        
        with open(self.log_file, 'w') as f:
            json.dump(logs, f, indent=2)
        
        logger.info(f"Logged {response} response from user {username} ({user_id})")
    
    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /start command - regular user flow"""
        user_id = update.effective_user.id
        username = update.effective_user.username or "there"
        
        # Check if user is already an admin
        if user_id in self.admin_users:
            admin_welcome = f"Welcome back, Admin!\n\n"
            admin_welcome += "Available Commands:\n"
            admin_welcome += "/stats - View today's statistics\n"
            admin_welcome += "/logs - View available log dates\n"
            admin_welcome += "/broadcast - Send message to all users\n\n"
            admin_welcome += "You won't receive daily questions."
            await update.message.reply_text(admin_welcome)
            return
        
        # Regular user flow
        self.user_states[user_id] = 'active'
        self.regular_users.add(user_id)  # Add to regular users for daily messages
        self.save_users()  # Save users to file
        
        welcome_text = "سلام ثارینا! 👋\n\nمن اینجام تا بهت یادآوری کنم قرص‌هات رو بخوری! 💊"
        await update.message.reply_text(welcome_text)
        await self.send_question(update, context)
    
    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle text messages - check for hidden admin code or user management"""
        user_id = update.effective_user.id
        text = update.message.text
        
        # Check if there's a pending user management action
        if user_id in self.admin_users and 'pending_action' in context.user_data:
            action = context.user_data['pending_action']
            del context.user_data['pending_action']
            
            # Parse user ID from message
            target_user_id = None
            if text.isdigit():
                target_user_id = int(text)
            elif text.startswith('@'):
                # Try to find user by username in logs
                await update.message.reply_text(
                    "Username lookup not implemented yet. Please use numeric user ID.\n"
                    "You can find user IDs in the /users list."
                )
                return
            else:
                await update.message.reply_text("Invalid user ID format. Please send a numeric user ID.")
                return
            
            # Perform the action
            if action == "user_make_admin":
                if target_user_id in self.regular_users:
                    self.regular_users.remove(target_user_id)
                self.admin_users.add(target_user_id)
                self.save_users()
                await update.message.reply_text(f"✅ User {target_user_id} is now an admin.")
            elif action == "user_remove_admin":
                if target_user_id in self.admin_users:
                    self.admin_users.remove(target_user_id)
                    self.regular_users.add(target_user_id)
                    self.save_users()
                    await update.message.reply_text(f"✅ User {target_user_id} removed from admins.")
                else:
                    await update.message.reply_text(f"❌ User {target_user_id} is not an admin.")
            return
        
        # Check if message contains admin code
        if text == self.admin_code:
            self.admin_users.add(user_id)
            if user_id in self.regular_users:
                self.regular_users.remove(user_id)
            self.save_users()  # Save users to file
            
            admin_welcome = "Admin access granted!\n\n"
            admin_welcome += "Available Commands:\n"
            admin_welcome += "/admin - Show admin menu with buttons\n"
            admin_welcome += "/stats - View today's statistics\n"
            admin_welcome += "/logs - View available log dates\n"
            admin_welcome += "/users - Manage users\n"
            admin_welcome += "/exit - Exit admin mode\n\n"
            admin_welcome += "You won't receive daily questions.\n"
            admin_welcome += "You'll get notifications when users select 'Yes'."
            
            await update.message.reply_text(admin_welcome)
        else:
            # Ignore other text messages
            pass
    
    async def show_stats_inline(self, query, context: ContextTypes.DEFAULT_TYPE):
        """Show statistics inline with back button"""
        try:
            with open(self.log_file, 'r') as f:
                logs = json.load(f)
            
            today = date.today().isoformat()
            if today not in logs:
                stats_text = "No data available for today."
            else:
                stats = logs[today]
                stats_text = f"📊 Daily Statistics - {stats['date']}\n\n"
                stats_text += f"Total Responses: {stats['total_responses']}\n"
                stats_text += f"Yes Responses: {stats['yes_responses']}\n"
                stats_text += f"No Responses: {stats['no_responses']}\n\n"
                
                if stats['total_responses'] > 0:
                    yes_percentage = (stats['yes_responses'] / stats['total_responses']) * 100
                    no_percentage = (stats['no_responses'] / stats['total_responses']) * 100
                    stats_text += f"Percentages:\n"
                    stats_text += f"  Yes: {yes_percentage:.1f}%\n"
                    stats_text += f"  No: {no_percentage:.1f}%\n\n"
                
                if stats['users']:
                    stats_text += f"Active Users: {len(stats['users'])}\n"
                    for user_id, user_data in stats['users'].items():
                        stats_text += f"  • {user_data['username']}: {user_data['yes_count']}Yes {user_data['no_count']}No\n"
            
            keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data="admin_back")]]
            reply_markup = InlineKeyboardMarkup(keyboard)
            await query.edit_message_text(stats_text, reply_markup=reply_markup)
            
        except Exception as e:
            keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data="admin_back")]]
            reply_markup = InlineKeyboardMarkup(keyboard)
            await query.edit_message_text(f"Error getting stats: {e}", reply_markup=reply_markup)
    
    async def stats_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /stats command"""
        user_id = update.effective_user.id
        
        if user_id not in self.admin_users:
            await update.message.reply_text("This command is not available.")
            return
        
        # Get today's stats
        today = date.today().isoformat()
        try:
            with open(self.log_file, 'r') as f:
                logs = json.load(f)
            
            if today not in logs:
                await update.message.reply_text("No data available for today.")
                return
            
            stats = logs[today]
            stats_text = f"Daily Statistics - {stats['date']}\n\n"
            stats_text += f"Total Responses: {stats['total_responses']}\n"
            stats_text += f"Yes Responses: {stats['yes_responses']}\n"
            stats_text += f"No Responses: {stats['no_responses']}\n\n"
            
            if stats['total_responses'] > 0:
                yes_percentage = (stats['yes_responses'] / stats['total_responses']) * 100
                no_percentage = (stats['no_responses'] / stats['total_responses']) * 100
                stats_text += f"Percentages:\n"
                stats_text += f"  Yes: {yes_percentage:.1f}%\n"
                stats_text += f"  No: {no_percentage:.1f}%\n\n"
            
            if stats['users']:
                stats_text += f"Active Users: {len(stats['users'])}\n"
                for user_id, user_data in stats['users'].items():
                    stats_text += f"  • {user_data['username']}: {user_data['yes_count']}Yes {user_data['no_count']}No\n"
            
            await update.message.reply_text(stats_text)
            
        except Exception as e:
            await update.message.reply_text(f"Error getting stats: {e}")
    
    async def show_logs_inline(self, query, context: ContextTypes.DEFAULT_TYPE):
        """Show logs inline with back button"""
        try:
            with open(self.log_file, 'r') as f:
                logs = json.load(f)
            
            if not logs:
                dates_text = "No logs available."
            else:
                dates_text = "📝 Available Log Dates:\n\n"
                for date_str in sorted(logs.keys(), reverse=True)[:10]:
                    stats = logs[date_str]
                    dates_text += f"{date_str}\n"
                    dates_text += f"  Total: {stats['total_responses']} | Yes: {stats['yes_responses']} | No: {stats['no_responses']}\n\n"
            
            keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data="admin_back")]]
            reply_markup = InlineKeyboardMarkup(keyboard)
            await query.edit_message_text(dates_text, reply_markup=reply_markup)
            
        except Exception as e:
            keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data="admin_back")]]
            reply_markup = InlineKeyboardMarkup(keyboard)
            await query.edit_message_text(f"Error getting logs: {e}", reply_markup=reply_markup)
    
    async def logs_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /logs command"""
        user_id = update.effective_user.id
        
        if user_id not in self.admin_users:
            await update.message.reply_text("This command is not available.")
            return
        
        try:
            with open(self.log_file, 'r') as f:
                logs = json.load(f)
            
            if not logs:
                await update.message.reply_text("No logs available.")
                return
            
            dates_text = "Available Log Dates:\n\n"
            for date_str in sorted(logs.keys(), reverse=True)[:10]:
                stats = logs[date_str]
                dates_text += f"{date_str}\n"
                dates_text += f"  Total: {stats['total_responses']} | Yes: {stats['yes_responses']} | No: {stats['no_responses']}\n\n"
            
            await update.message.reply_text(dates_text)
            
        except Exception as e:
            await update.message.reply_text(f"Error getting logs: {e}")
    
    async def exit_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /exit command - exit admin mode"""
        user_id = update.effective_user.id
        
        if user_id not in self.admin_users:
            await update.message.reply_text("You are not in admin mode.")
            return
        
        # Remove from admins, add to regular users
        self.admin_users.remove(user_id)
        self.regular_users.add(user_id)
        self.save_users()
        
        await update.message.reply_text(
            "You've exited admin mode and are now a regular user.\n"
            "You'll receive daily questions again.\n"
            "Use /start to continue."
        )
    
    def build_admin_menu(self):
        """Build main admin menu"""
        menu_text = "ADMIN PANEL\n"
        menu_text += "=" * 30 + "\n\n"
        menu_text += "Select an option:\n\n"
        menu_text += "/stats - View today's statistics\n"
        menu_text += "/logs - View available log dates\n"
        menu_text += "/users - Manage users\n"
        menu_text += "/exit - Exit admin mode\n"
        
        keyboard = [
            [
                InlineKeyboardButton("📊 Statistics", callback_data="admin_stats"),
                InlineKeyboardButton("📝 Logs", callback_data="admin_logs")
            ],
            [
                InlineKeyboardButton("👥 Manage Users", callback_data="admin_users")
            ],
            [
                InlineKeyboardButton("🚪 Exit Admin", callback_data="admin_exit")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        return menu_text, reply_markup
    
    def build_users_list(self):
        """Build user management text and keyboard"""
        # Get user statistics
        try:
            with open(self.log_file, 'r') as f:
                logs = json.load(f)
            
            # Collect all unique users from logs
            all_users_data = {}
            for date_str, day_data in logs.items():
                for uid, udata in day_data.get('users', {}).items():
                    if uid not in all_users_data:
                        all_users_data[uid] = {
                            'username': udata['username'],
                            'total_yes': 0,
                            'total_no': 0,
                            'first_seen': date_str,
                            'last_seen': date_str
                        }
                    all_users_data[uid]['total_yes'] += udata.get('yes_count', 0)
                    all_users_data[uid]['total_no'] += udata.get('no_count', 0)
                    all_users_data[uid]['last_seen'] = date_str
        except:
            all_users_data = {}
        
        # Build user management message
        users_text = "USER MANAGEMENT\n"
        users_text += "=" * 30 + "\n\n"
        
        # Admins
        users_text += f"ADMINS ({len(self.admin_users)}):\n"
        for admin_id in self.admin_users:
            admin_info = all_users_data.get(str(admin_id), {})
            username = admin_info.get('username', f'ID: {admin_id}')
            users_text += f"  - {username}\n"
        
        users_text += f"\nREGULAR USERS ({len(self.regular_users)}):\n"
        for reg_id in list(self.regular_users)[:20]:  # Limit to 20 users
            user_info = all_users_data.get(str(reg_id), {})
            username = user_info.get('username', f'ID: {reg_id}')
            total_responses = user_info.get('total_yes', 0) + user_info.get('total_no', 0)
            users_text += f"  - {username} ({total_responses} responses)\n"
        
        if len(self.regular_users) > 20:
            users_text += f"  ... and {len(self.regular_users) - 20} more\n"
        
        users_text += "\nSTATISTICS:\n"
        users_text += f"  Total users: {len(self.admin_users) + len(self.regular_users)}\n"
        users_text += f"  Admins: {len(self.admin_users)}\n"
        users_text += f"  Regular users: {len(self.regular_users)}\n"
        
        users_text += "\nTIP: Use buttons below to manage users"
        
        # Create inline keyboard for user management
        keyboard = [
            [
                InlineKeyboardButton("+ Make Admin", callback_data="user_make_admin"),
                InlineKeyboardButton("- Remove Admin", callback_data="user_remove_admin")
            ],
            [
                InlineKeyboardButton("🔄 Refresh", callback_data="user_refresh"),
                InlineKeyboardButton("⬅️ Back", callback_data="admin_back")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        return users_text, reply_markup
    
    async def show_users_list(self, query_or_update, context: ContextTypes.DEFAULT_TYPE):
        """Show users list - works for both callback query and command"""
        users_text, reply_markup = self.build_users_list()
        
        if isinstance(query_or_update, Update):
            # Called from command
            await query_or_update.message.reply_text(users_text, reply_markup=reply_markup)
        else:
            # Called from callback query
            try:
                await query_or_update.edit_message_text(users_text, reply_markup=reply_markup)
            except telegram.error.BadRequest as e:
                # If message content hasn't changed, just acknowledge the callback
                if "message is not modified" in str(e).lower():
                    await query_or_update.answer("List is already up to date!")
                else:
                    raise
    
    async def admin_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /admin command - show admin menu"""
        user_id = update.effective_user.id
        
        if user_id not in self.admin_users:
            await update.message.reply_text("This command is not available.")
            return
        
        menu_text, reply_markup = self.build_admin_menu()
        await update.message.reply_text(menu_text, reply_markup=reply_markup)
    
    async def users_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle /users command - user management"""
        user_id = update.effective_user.id
        
        if user_id not in self.admin_users:
            await update.message.reply_text("This command is not available.")
            return
        
        await self.show_users_list(update, context)
    
    async def send_question(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Send the yes/no question"""
        keyboard = [
            [
                InlineKeyboardButton("بله، خوردم! ✅", callback_data="yes"),
                InlineKeyboardButton("هنوز نه 😅", callback_data="no")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        question_text = "قرص‌هات رو خوردی؟ 💊"
        
        if update.callback_query:
            await update.callback_query.edit_message_text(
                text=question_text,
                reply_markup=reply_markup
            )
        else:
            await update.message.reply_text(
                text=question_text,
                reply_markup=reply_markup
            )
    
    async def handle_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handle button callbacks"""
        query = update.callback_query
        await query.answer()
        
        user_id = query.from_user.id
        data = query.data
        
        if user_id not in self.user_states:
            self.user_states[user_id] = 'active'
        
        # Handle admin menu callbacks
        if data == "admin_back":
            # Go back to admin menu
            menu_text, reply_markup = self.build_admin_menu()
            try:
                await query.edit_message_text(menu_text, reply_markup=reply_markup)
            except telegram.error.BadRequest as e:
                if "message is not modified" in str(e).lower():
                    await query.answer("Already at main menu!")
                else:
                    raise
            return
        elif data == "admin_stats":
            # Show stats inline
            await self.show_stats_inline(query, context)
            return
        elif data == "admin_logs":
            # Show logs inline
            await self.show_logs_inline(query, context)
            return
        elif data == "admin_users":
            # Show user management
            await self.show_users_list(query, context)
            return
        elif data == "admin_exit":
            # Exit admin mode
            if user_id in self.admin_users:
                self.admin_users.remove(user_id)
                self.regular_users.add(user_id)
                self.save_users()
                await query.edit_message_text(
                    "You've exited admin mode and are now a regular user.\n"
                    "You'll receive daily questions again.\n"
                    "Use /start to continue."
                )
            return
        
        # Handle user management callbacks
        if data == "user_refresh":
            # Refresh user list - send new message with user list
            await query.answer("Refreshing...")
            # Don't call users_command, rebuild the list here
            await self.show_users_list(query, context)
            return
        elif data == "user_make_admin" or data == "user_remove_admin":
            keyboard = [[InlineKeyboardButton("⬅️ Back", callback_data="admin_users_return")]]
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            await query.edit_message_text(
                "To manage users, send me their user ID or username.\n\n"
                f"Action: {'Make Admin' if data == 'user_make_admin' else 'Remove Admin'}\n\n"
                "Reply with:\n"
                "• User ID (e.g., 123456789)\n"
                "• Or @username",
                reply_markup=reply_markup
            )
            # Store the action for the next message
            context.user_data['pending_action'] = data
            return
        elif data == "admin_users_return":
            # Return to user management from action prompt
            if 'pending_action' in context.user_data:
                del context.user_data['pending_action']
            await self.show_users_list(query, context)
            return
        
        # Handle yes/no responses
        if data == "yes":
            await self.handle_yes_choice(query, context)
        elif data == "no":
            await self.handle_no_choice(query, context)
    
    async def handle_yes_choice(self, query, context: ContextTypes.DEFAULT_TYPE):
        """Handle when user selects yes"""
        user = query.from_user
        user_info = f"@{user.username}" if user.username else f"User ID: {user.id}"
        
        self.log_response(user.id, user_info, 'yes')
        
        await query.edit_message_text(
            "عالیه! 🎉\nممنون که قرص‌هات رو خوردی. مراقب خودت باش! 💚\n\nگل برای گل 🌸"
        )
        
        admin_message = f"Notification from bot:\n\nUser {user_info} has selected 'Yes'!\n\nUser details:\n- Name: {user.first_name} {user.last_name or ''}\n- Username: {user_info}\n- User ID: {user.id}"
        
        try:
            if self.admin_users:
                for admin_id in self.admin_users:
                    try:
                        await context.bot.send_message(chat_id=admin_id, text=admin_message)
                        logger.info(f"Admin notification sent to {admin_id}")
                    except Exception as e:
                        logger.error(f"Failed to send notification to admin {admin_id}: {e}")
            else:
                logger.info(f"ADMIN NOTIFICATION (no admins set): {admin_message}")
                print(f"\n{'='*50}")
                print("ADMIN NOTIFICATION:")
                print(admin_message)
                print("No admin users found. Use /startadmin to become an admin.")
                print(f"{'='*50}\n")
            
        except Exception as e:
            logger.error(f"Failed to send admin notification: {e}")
            logger.info(f"ADMIN NOTIFICATION (fallback): {admin_message}")
    
    async def handle_no_choice(self, query, context: ContextTypes.DEFAULT_TYPE):
        """Handle when user selects no"""
        user = query.from_user
        user_info = f"@{user.username}" if user.username else f"User ID: {user.id}"
        
        self.log_response(user.id, user_info, 'no')
        
        await query.edit_message_text(
            "اشکالی نداره! 😊\n۱۵ دقیقه دیگه دوباره ازت می‌پرسم..."
        )
        
        # Schedule a job to send the question again after 15 minutes (900 seconds)
        context.job_queue.run_once(
            self.send_delayed_question,
            when=900,
            chat_id=user.id,
            name=f'delayed_question_{user.id}',
            data={'chat_id': user.id}
        )
    
    async def send_delayed_question(self, context: ContextTypes.DEFAULT_TYPE):
        """Send the question again after a delay"""
        chat_id = context.job.chat_id
        
        keyboard = [
            [
                InlineKeyboardButton("بله، خوردم! ✅", callback_data="yes"),
                InlineKeyboardButton("هنوز نه 😅", callback_data="no")
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await context.bot.send_message(
            chat_id=chat_id,
            text="قرص‌هات رو خوردی؟ 💊",
            reply_markup=reply_markup
        )
    
    async def send_daily_message(self, context: ContextTypes.DEFAULT_TYPE):
        """Send daily message to all regular users at 12pm Tehran time"""
        logger.info("Sending daily messages...")
        
        for user_id in self.regular_users:
            try:
                keyboard = [
                    [
                        InlineKeyboardButton("بله، خوردم! ✅", callback_data="yes"),
                        InlineKeyboardButton("هنوز نه 😅", callback_data="no")
                    ]
                ]
                reply_markup = InlineKeyboardMarkup(keyboard)
                
                await context.bot.send_message(
                    chat_id=user_id,
                    text="قرص‌هات رو خوردی؟ 💊",
                    reply_markup=reply_markup
                )
                logger.info(f"Daily message sent to user {user_id}")
            except Exception as e:
                logger.error(f"Failed to send daily message to user {user_id}: {e}")

def main():
    """Start the bot"""
    if not BOT_TOKEN:
        print("Error: BOT_TOKEN environment variable not set!")
        print("Please set your bot token: export BOT_TOKEN='your_bot_token_here'")
        return
    
    bot = SimpleBot()
    application = Application.builder().token(BOT_TOKEN).build()
    
    # Add handlers
    application.add_handler(CommandHandler("start", bot.start_command))
    application.add_handler(CommandHandler("admin", bot.admin_command))
    application.add_handler(CommandHandler("stats", bot.stats_command))
    application.add_handler(CommandHandler("logs", bot.logs_command))
    application.add_handler(CommandHandler("users", bot.users_command))
    application.add_handler(CommandHandler("exit", bot.exit_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, bot.handle_message))
    application.add_handler(CallbackQueryHandler(bot.handle_callback))
    
    # Set up daily job at 12:00 PM Tehran time
    tehran_tz = pytz.timezone('Asia/Tehran')
    job_queue = application.job_queue
    
    # Create time object with Tehran timezone
    daily_time = time(hour=12, minute=0, second=0, tzinfo=tehran_tz)
    
    job_queue.run_daily(
        bot.send_daily_message,
        time=daily_time,
        days=(0, 1, 2, 3, 4, 5, 6),  # All days of the week
        name='daily_message'
    )
    
    print("Bot is starting...")
    print("Daily messages scheduled for 12:00 PM Asia/Tehran time")
    print("Admin code: Admin2024")
    print("Press Ctrl+C to stop the bot")
    
    try:
        application.run_polling()
    except KeyboardInterrupt:
        print("\nBot stopped by user")
    except Exception as e:
        logger.error(f"Bot error: {e}")
        print(f"Error: {e}")

if __name__ == '__main__':
    main()
