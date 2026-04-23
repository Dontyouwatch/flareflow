# Minimal n8n - Cloudflare Workers Workflow Automation

A lightweight n8n-like workflow automation system built with Cloudflare Workers, Pages, and KV storage.

## Features

### Supported Nodes
- **HTTP Node** - Make API requests (GET, POST, etc.)
- **Schedule Trigger** - Time-based execution via cron
- **Loop Node** - Process items one by one from arrays
- **Wait Node** - Delay execution (configurable duration)
- **Telegram Node** - Send messages to Telegram chats

### Your Use Case ✅
The system is designed for your exact workflow:
```
HTTP Request → Fetch 10 items from API
     ↓
Loop Through Items (one at a time)
     ↓
Telegram Node → Send 1 item to chat
     ↓
Wait Node → Pause 1 hour
     ↓
(Repeat until all 10 items sent in a day)
```

## Project Structure

```
minimal-n8n/
├── worker/index.js      # Main workflow engine
├── pages/src/           # Web dashboard (served by worker)
├── wrangler.toml        # Cloudflare configuration
└── package.json         # Dependencies
```

## Quick Start

### 1. Install Dependencies
```bash
cd minimal-n8n
npm install
```

### 2. Get Telegram Credentials

1. **Create a Bot**: Message @BotFather on Telegram
   - Send `/newbot`
   - Follow prompts to get your bot token

2. **Get Chat ID**: 
   - Add your bot to a group/channel or message it
   - Send a message and visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Find the `chat.id` in the response

### 3. Configure wrangler.toml

Edit `wrangler.toml` and replace:
```toml
TELEGRAM_BOT_TOKEN = "YOUR_BOT_TOKEN_HERE"
TELEGRAM_CHAT_ID = "YOUR_CHAT_ID_HERE"
```

### 4. Create KV Namespace

```bash
npx wrangler kv:namespace create workflow_store
```

Copy the returned ID and update `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "WORKFLOW_STORE"
id = "copied_id_here"
```

### 5. Deploy

```bash
npm run deploy
```

Your workflow engine is now live!

## Usage

### Web Dashboard

Visit your deployed URL to access the dashboard where you can:
- Create new workflows with custom API URLs
- Configure wait times between items
- View active workflows with status
- Manually execute or delete workflows
- See visual node representation and execution logs

### Creating a Workflow

1. Go to the dashboard
2. Fill in:
   - **Workflow Name**: e.g., "Daily API Sender"
   - **API URL**: Your endpoint that returns an array of items
   - **Telegram Message**: Template with `{{item}}` placeholder
   - **Wait Time**: Minutes between each item (default: 60)
3. Click "Create Workflow"
4. Click "Execute" to start

### API Endpoints

- `POST /api/workflows` - Create a new workflow
- `GET /api/workflows` - List all workflows
- `GET /api/workflows/:id` - Get workflow details
- `POST /api/workflows/:id/execute` - Execute a workflow
- `DELETE /api/workflows/:id` - Delete a workflow
- `POST /api/trigger` - Manual trigger for scheduled workflows

### Example Workflow Definition

```json
{
  "name": "Daily Item Sender",
  "nodes": [
    {
      "id": "node_1",
      "type": "http",
      "config": {
        "url": "https://api.example.com/items",
        "method": "GET"
      }
    },
    {
      "id": "node_2",
      "type": "loop",
      "config": { "over": "items" }
    },
    {
      "id": "node_3",
      "type": "telegram",
      "config": {
        "message": "New item: {{item}}"
      }
    },
    {
      "id": "node_4",
      "type": "wait",
      "config": {
        "waitTime": 3600000
      }
    }
  ]
}
```

## How It Works

1. **HTTP Node** fetches data from your API (e.g., 10 items)
2. **Loop Node** iterates through items one at a time
3. **Telegram Node** sends the current item to your chat
4. **Wait Node** pauses execution for the specified duration
5. State persists in Cloudflare KV storage
6. Cron triggers (every minute) resume waiting workflows automatically

## Development

```bash
# Run locally
npm run dev

# Test Pages locally
npm run pages:dev
```

## Notes

- Workflows automatically resume after wait periods via cron triggers
- All state is stored in Cloudflare KV (serverless, persistent)
- The dashboard is served directly by the Worker (no separate hosting needed)
- Default wait time is 1 hour (configurable per workflow)

## Troubleshooting

**Telegram errors**: Verify your bot token and chat ID are correct in `wrangler.toml`

**KV errors**: Ensure you've created the namespace and updated the ID

**Workflow not resuming**: Check that cron triggers are enabled in your deployment

---

Built with ❤️ using Cloudflare Workers
