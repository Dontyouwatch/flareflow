/**
 * Minimal n8n-like Workflow Engine for Cloudflare Workers
 * 
 * Supports: HTTP, Schedule, Loop, Wait, Telegram nodes
 */

// Node types
const NODE_TYPES = {
  HTTP: 'http',
  SCHEDULE: 'schedule',
  LOOP: 'loop',
  WAIT: 'wait',
  TELEGRAM: 'telegram'
};

// Default wait time in milliseconds (1 hour)
const DEFAULT_WAIT_TIME = 60 * 60 * 1000;

/**
 * Execute a workflow step
 */
async function executeNode(node, context, env) {
  const { type, config } = node;
  
  switch (type) {
    case NODE_TYPES.HTTP:
      return await executeHttpNode(config, context);
    
    case NODE_TYPES.SCHEDULE:
      return await executeScheduleNode(config, context);
    
    case NODE_TYPES.LOOP:
      return await executeLoopNode(config, context);
    
    case NODE_TYPES.WAIT:
      return await executeWaitNode(config, context);
    
    case NODE_TYPES.TELEGRAM:
      return await executeTelegramNode(config, context, env);
    
    default:
      throw new Error(`Unknown node type: ${type}`);
  }
}

/**
 * HTTP Node - Make API requests
 */
async function executeHttpNode(config, context) {
  const { url, method = 'GET', headers = {}, body = null } = config;
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  
  if (!response.ok) {
    throw new Error(`HTTP request failed: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  
  // Handle array responses for looping
  const items = Array.isArray(data) ? data : [data];
  
  return {
    success: true,
    output: data,
    items: items,
    itemCount: items.length
  };
}

/**
 * Schedule Node - Time-based trigger
 */
async function executeScheduleNode(config, context) {
  const { cronExpression } = config;
  
  // In Cloudflare Workers, schedules are handled by cron triggers
  // This node just validates the schedule
  return {
    success: true,
    message: `Scheduled with cron: ${cronExpression}`,
    nextRun: getNextCronTime(cronExpression)
  };
}

function getNextCronTime(cronExpression) {
  // Simplified cron parser - just returns next minute for demo
  return new Date(Date.now() + 60000).toISOString();
}

/**
 * Loop Node - Process items one by one
 */
async function executeLoopNode(config, context) {
  const { items, currentIndex = 0 } = context.state || {};
  
  if (!items || items.length === 0) {
    return {
      success: false,
      message: 'No items to loop',
      completed: true
    };
  }
  
  if (currentIndex >= items.length) {
    return {
      success: true,
      message: 'All items processed',
      completed: true,
      currentIndex: items.length
    };
  }
  
  const currentItem = items[currentIndex];
  
  return {
    success: true,
    currentItem,
    currentIndex,
    totalItems: items.length,
    remaining: items.length - currentIndex,
    completed: false
  };
}

/**
 * Wait Node - Delay execution
 */
async function executeWaitNode(config, context) {
  const { waitTime = DEFAULT_WAIT_TIME } = config;
  const now = Date.now();
  const resumeAt = now + waitTime;
  
  return {
    success: true,
    message: `Waiting for ${waitTime / 1000} seconds`,
    resumeAt,
    resumeAtISO: new Date(resumeAt).toISOString()
  };
}

/**
 * Telegram Node - Send messages to Telegram
 */
async function executeTelegramNode(config, context, env) {
  const { chatId, message, parseMode = 'HTML' } = config;
  
  // Use environment variables if not provided in config
  const token = config.botToken || env.TELEGRAM_BOT_TOKEN;
  const targetChatId = chatId || env.TELEGRAM_CHAT_ID;
  
  if (!token || !targetChatId) {
    throw new Error('Telegram bot token or chat ID not configured');
  }
  
  // Get current item from loop context
  const { currentItem } = context.state || {};
  
  // Format message with current item data if available
  let finalMessage = message;
  if (currentItem) {
    finalMessage = message.replace('{{item}}', JSON.stringify(currentItem, null, 2));
    
    // Auto-format if message contains {{item}} placeholder
    if (message.includes('{{item}}')) {
      finalMessage = `<pre>${escapeHtml(JSON.stringify(currentItem, null, 2))}</pre>`;
    } else {
      // Append item info
      finalMessage = `${message}\n\n<pre>${escapeHtml(JSON.stringify(currentItem, null, 2))}</pre>`;
    }
  }
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: targetChatId,
      text: finalMessage,
      parse_mode: parseMode
    })
  });
  
  const result = await response.json();
  
  if (!result.ok) {
    throw new Error(`Telegram API error: ${result.description}`);
  }
  
  return {
    success: true,
    messageId: result.result.message_id,
    message: finalMessage
  };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Workflow State Management
 */
async function getWorkflowState(workflowId, env) {
  const key = `workflow:${workflowId}`;
  const data = await env.WORKFLOW_STORE.get(key, { type: 'json' });
  return data || { status: 'idle', steps: [] };
}

async function saveWorkflowState(workflowId, state, env) {
  const key = `workflow:${workflowId}`;
  await env.WORKFLOW_STORE.put(key, JSON.stringify(state));
}

async function deleteWorkflowState(workflowId, env) {
  const key = `workflow:${workflowId}`;
  await env.WORKFLOW_STORE.delete(key);
}

/**
 * Execute a complete workflow
 */
async function executeWorkflow(workflow, env, forceStep = null) {
  const { id, nodes } = workflow;
  let state = await getWorkflowState(id, env);
  
  // Initialize state if new workflow
  if (!state.steps || state.steps.length === 0) {
    state = {
      status: 'running',
      createdAt: Date.now(),
      currentNodeIndex: 0,
      steps: [],
      state: {}
    };
  }
  
  // Check if workflow is waiting
  if (state.status === 'waiting') {
    const { resumeAt } = state;
    if (resumeAt && Date.now() < resumeAt) {
      return {
        success: true,
        message: `Workflow still waiting until ${new Date(resumeAt).toISOString()}`,
        state
      };
    }
    // Resume workflow
    state.status = 'running';
  }
  
  try {
    // Execute nodes in sequence
    while (state.currentNodeIndex < nodes.length) {
      const nodeIndex = forceStep !== null ? forceStep : state.currentNodeIndex;
      const node = nodes[nodeIndex];
      
      if (!node) {
        break;
      }
      
      // Prepare context
      const context = {
        workflowId: id,
        nodeId: node.id,
        nodeType: node.type,
        state: state.state,
        previousSteps: state.steps
      };
      
      // Execute node
      const result = await executeNode(node, context, env);
      
      // Record step
      state.steps.push({
        nodeId: node.id,
        nodeType: node.type,
        timestamp: Date.now(),
        result
      });
      
      // Update state with node output
      if (result.items) {
        state.state.items = result.items;
      }
      if (result.currentItem !== undefined) {
        state.state.currentItem = result.currentItem;
        state.state.currentIndex = result.currentIndex;
      }
      
      // Handle wait node
      if (node.type === NODE_TYPES.WAIT && result.resumeAt) {
        state.status = 'waiting';
        state.resumeAt = result.resumeAt;
        await saveWorkflowState(id, state, env);
        
        return {
          success: true,
          message: 'Workflow paused - waiting',
          resumeAt: result.resumeAt,
          state
        };
      }
      
      // Handle loop completion
      if (node.type === NODE_TYPES.LOOP) {
        if (result.completed) {
          // Loop finished, move to next node
          state.currentNodeIndex++;
          state.state.currentIndex = 0;
        } else {
          // Still looping - execute next action (send message, then wait)
          // For our use case: send telegram message, then wait
          
          // Check if there's a telegram node after this loop
          const nextNode = nodes[state.currentNodeIndex + 1];
          const waitNode = nodes[state.currentNodeIndex + 2];
          
          if (nextNode && nextNode.type === NODE_TYPES.TELEGRAM) {
            // Execute telegram node immediately
            const telegramResult = await executeNode(nextNode, context, env);
            
            state.steps.push({
              nodeId: nextNode.id,
              nodeType: NODE_TYPES.TELEGRAM,
              timestamp: Date.now(),
              result: telegramResult
            });
          }
          
          if (waitNode && waitNode.type === NODE_TYPES.WAIT) {
            // Execute wait node
            const waitResult = await executeNode(waitNode, context, env);
            
            state.steps.push({
              nodeId: waitNode.id,
              nodeType: NODE_TYPES.WAIT,
              timestamp: Date.now(),
              result: waitResult
            });
            
            state.status = 'waiting';
            state.resumeAt = waitResult.resumeAt;
            state.currentNodeIndex = 0; // Restart from HTTP to continue loop
            
            // Increment loop counter
            state.state.currentIndex = (state.state.currentIndex || 0) + 1;
            
            await saveWorkflowState(id, state, env);
            
            return {
              success: true,
              message: `Sent item ${state.state.currentIndex}/${result.totalItems}, waiting 1 hour`,
              resumeAt: waitResult.resumeAt,
              state
            };
          }
          
          state.currentNodeIndex++;
        }
      } else {
        state.currentNodeIndex++;
      }
      
      // If we forced a step, stop after executing it
      if (forceStep !== null) {
        break;
      }
    }
    
    // Workflow completed
    state.status = 'completed';
    state.completedAt = Date.now();
    await saveWorkflowState(id, state, env);
    
    return {
      success: true,
      message: 'Workflow completed successfully',
      state
    };
    
  } catch (error) {
    state.status = 'error';
    state.error = error.message;
    await saveWorkflowState(id, state, env);
    
    return {
      success: false,
      error: error.message,
      state
    };
  }
}

/**
 * Cloudflare Worker Entry Point
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    // API Routes
    if (path.startsWith('/api/')) {
      return handleApiRequest(request, env, corsHeaders);
    }
    
    // Trigger endpoint for cron jobs
    if (path === '/trigger') {
      return handleTrigger(request, env, corsHeaders);
    }
    
    // Serve static files from Pages
    if (path === '/' || path.startsWith('/dashboard')) {
      return serveDashboard();
    }
    
    return new Response('Not Found', { status: 404 });
  },
  
  async scheduled(event, env, ctx) {
    // Handle cron-triggered workflows
    const workflows = await env.WORKFLOW_STORE.list({ prefix: 'workflow:' });
    
    for (const key of workflows.keys) {
      const workflow = await env.WORKFLOW_STORE.get(key.name, { type: 'json' });
      
      if (workflow && workflow.status === 'waiting') {
        if (workflow.resumeAt && Date.now() >= workflow.resumeAt) {
          // Resume workflow
          ctx.waitUntil(executeWorkflow(workflow, env));
        }
      }
    }
  }
};

/**
 * API Request Handler
 */
async function handleApiRequest(request, env, corsHeaders) {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');
  
  try {
    // Create workflow
    if (path === 'workflows' && request.method === 'POST') {
      const workflow = await request.json();
      const workflowId = `wf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      const newWorkflow = {
        id: workflowId,
        name: workflow.name || 'Untitled Workflow',
        nodes: workflow.nodes || [],
        createdAt: Date.now(),
        status: 'idle'
      };
      
      await saveWorkflowState(workflowId, {
        status: 'idle',
        steps: [],
        state: {}
      }, env);
      
      // Store workflow definition
      await env.WORKFLOW_STORE.put(`definition:${workflowId}`, JSON.stringify(newWorkflow));
      
      return jsonResponse({ success: true, workflow: newWorkflow }, corsHeaders);
    }
    
    // List workflows
    if (path === 'workflows' && request.method === 'GET') {
      const list = await env.WORKFLOW_STORE.list({ prefix: 'definition:' });
      const workflows = [];
      
      for (const key of list.keys) {
        const wf = await env.WORKFLOW_STORE.get(key.name, { type: 'json' });
        const state = await getWorkflowState(wf.id, env);
        workflows.push({ ...wf, state });
      }
      
      return jsonResponse({ success: true, workflows }, corsHeaders);
    }
    
    // Get single workflow
    if (path.startsWith('workflows/') && request.method === 'GET') {
      const workflowId = path.split('/')[1];
      const workflow = await env.WORKFLOW_STORE.get(`definition:${workflowId}`, { type: 'json' });
      const state = await getWorkflowState(workflowId, env);
      
      if (!workflow) {
        return jsonResponse({ success: false, error: 'Workflow not found' }, corsHeaders, 404);
      }
      
      return jsonResponse({ success: true, workflow: { ...workflow, state } }, corsHeaders);
    }
    
    // Execute workflow
    if (path.startsWith('workflows/') && path.endsWith('/execute') && request.method === 'POST') {
      const workflowId = path.split('/')[1];
      const workflow = await env.WORKFLOW_STORE.get(`definition:${workflowId}`, { type: 'json' });
      
      if (!workflow) {
        return jsonResponse({ success: false, error: 'Workflow not found' }, corsHeaders, 404);
      }
      
      const result = await executeWorkflow(workflow, env);
      return jsonResponse(result, corsHeaders);
    }
    
    // Delete workflow
    if (path.startsWith('workflows/') && request.method === 'DELETE') {
      const workflowId = path.split('/')[1];
      await deleteWorkflowState(workflowId, env);
      await env.WORKFLOW_STORE.delete(`definition:${workflowId}`);
      
      return jsonResponse({ success: true, message: 'Workflow deleted' }, corsHeaders);
    }
    
    return jsonResponse({ success: false, error: 'Not found' }, corsHeaders, 404);
    
  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, corsHeaders, 500);
  }
}

/**
 * Handle manual trigger
 */
async function handleTrigger(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, corsHeaders, 405);
  }
  
  const { workflowId } = await request.json();
  
  if (!workflowId) {
    return jsonResponse({ success: false, error: 'workflowId required' }, corsHeaders, 400);
  }
  
  const workflow = await env.WORKFLOW_STORE.get(`definition:${workflowId}`, { type: 'json' });
  
  if (!workflow) {
    return jsonResponse({ success: false, error: 'Workflow not found' }, corsHeaders, 404);
  }
  
  const result = await executeWorkflow(workflow, env);
  return jsonResponse(result, corsHeaders);
}

/**
 * Serve Dashboard
 */
async function serveDashboard() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minimal n8n - Workflow Automation</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; line-height: 1.6; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { background: linear-gradient(135deg, #ff6b6b, #ee5a6f); color: white; padding: 30px 0; margin-bottom: 30px; }
    header h1 { font-size: 2.5em; margin-bottom: 10px; }
    header p { opacity: 0.9; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h2 { color: #ff6b6b; margin-bottom: 15px; font-size: 1.5em; }
    .btn { display: inline-block; padding: 10px 20px; background: #ff6b6b; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; text-decoration: none; transition: background 0.3s; }
    .btn:hover { background: #ee5a6f; }
    .btn-secondary { background: #6c757d; }
    .btn-secondary:hover { background: #5a6268; }
    .btn-success { background: #28a745; }
    .btn-success:hover { background: #218838; }
    .btn-danger { background: #dc3545; }
    .btn-danger:hover { background: #c82333; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 5px; font-weight: 600; color: #555; }
    .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
    .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: #ff6b6b; }
    .workflow-list { list-style: none; }
    .workflow-item { padding: 15px; border: 1px solid #eee; border-radius: 5px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
    .workflow-item:hover { background: #f9f9f9; }
    .status-badge { padding: 5px 10px; border-radius: 15px; font-size: 12px; font-weight: 600; }
    .status-idle { background: #e9ecef; color: #495057; }
    .status-running { background: #fff3cd; color: #856404; }
    .status-waiting { background: #d1ecf1; color: #0c5460; }
    .status-completed { background: #d4edda; color: #155724; }
    .status-error { background: #f8d7da; color: #721c24; }
    .node-visual { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }
    .node-box { padding: 10px 15px; background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 5px; font-size: 12px; font-weight: 600; }
    .node-http { border-color: #007bff; background: #e7f3ff; }
    .node-loop { border-color: #28a745; background: #e8f5e9; }
    .node-telegram { border-color: #17a2b8; background: #e0f7fa; }
    .node-wait { border-color: #ffc107; background: #fff8e1; }
    .arrow { color: #6c757d; font-size: 20px; align-self: center; }
    .log-output { background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 5px; font-family: 'Courier New', monospace; font-size: 12px; max-height: 300px; overflow-y: auto; }
    .hidden { display: none; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    @media (max-width: 768px) { .workflow-item { flex-direction: column; align-items: flex-start; gap: 10px; } }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1>⚡ Minimal n8n</h1>
      <p>Cloudflare Workers Workflow Automation</p>
    </div>
  </header>
  
  <div class="container">
    <!-- Create Workflow -->
    <div class="card">
      <h2>📝 Create New Workflow</h2>
      <form id="createWorkflowForm">
        <div class="form-group">
          <label>Workflow Name</label>
          <input type="text" id="workflowName" placeholder="My Daily API Sender" required>
        </div>
        <div class="form-group">
          <label>API URL (returns array of items)</label>
          <input type="url" id="apiUrl" placeholder="https://api.example.com/items" required>
        </div>
        <div class="form-group">
          <label>Telegram Message Template</label>
          <textarea id="telegramMessage" rows="3" placeholder="New item received: {{item}}">New update received!</textarea>
        </div>
        <div class="form-group">
          <label>Wait Time Between Items (minutes)</label>
          <input type="number" id="waitTime" value="60" min="1" max="1440">
        </div>
        <button type="submit" class="btn btn-success">Create Workflow</button>
      </form>
    </div>
    
    <!-- Active Workflows -->
    <div class="card">
      <h2>🔄 Active Workflows</h2>
      <button class="btn" onclick="loadWorkflows()">Refresh</button>
      <ul class="workflow-list" id="workflowList" style="margin-top: 20px;">
        <li>Loading...</li>
      </ul>
    </div>
    
    <!-- Workflow Details -->
    <div class="card hidden" id="workflowDetails">
      <h2>📊 Workflow Details</h2>
      <div id="workflowDetailsContent"></div>
    </div>
  </div>
  
  <script>
    const API_BASE = '';
    
    // Load workflows on page load
    document.addEventListener('DOMContentLoaded', loadWorkflows);
    
    // Create workflow
    document.getElementById('createWorkflowForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const name = document.getElementById('workflowName').value;
      const apiUrl = document.getElementById('apiUrl').value;
      const telegramMessage = document.getElementById('telegramMessage').value;
      const waitMinutes = parseInt(document.getElementById('waitTime').value);
      
      const workflow = {
        name,
        nodes: [
          {
            id: 'node_1',
            type: 'http',
            config: {
              url: apiUrl,
              method: 'GET'
            }
          },
          {
            id: 'node_2',
            type: 'loop',
            config: {
              over: 'items'
            }
          },
          {
            id: 'node_3',
            type: 'telegram',
            config: {
              message: telegramMessage
            }
          },
          {
            id: 'node_4',
            type: 'wait',
            config: {
              waitTime: waitMinutes * 60 * 1000
            }
          }
        ]
      };
      
      try {
        const response = await fetch(\`\${API_BASE}/api/workflows\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(workflow)
        });
        
        const result = await response.json();
        
        if (result.success) {
          alert('Workflow created! You can now execute it.');
          document.getElementById('createWorkflowForm').reset();
          loadWorkflows();
        } else {
          alert('Error: ' + result.error);
        }
      } catch (error) {
        alert('Error creating workflow: ' + error.message);
      }
    });
    
    // Load workflows
    async function loadWorkflows() {
      try {
        const response = await fetch(\`\${API_BASE}/api/workflows\`);
        const result = await response.json();
        
        if (result.success) {
          renderWorkflowList(result.workflows);
        }
      } catch (error) {
        document.getElementById('workflowList').innerHTML = '<li>Error loading workflows</li>';
      }
    }
    
    // Render workflow list
    function renderWorkflowList(workflows) {
      const list = document.getElementById('workflowList');
      
      if (workflows.length === 0) {
        list.innerHTML = '<li>No workflows yet. Create one above!</li>';
        return;
      }
      
      list.innerHTML = workflows.map(wf => {
        const statusClass = \`status-\${wf.state?.status || 'idle'}\`;
        const statusText = wf.state?.status || 'idle';
        
        return \`
          <li class="workflow-item">
            <div>
              <strong>\${wf.name}</strong><br>
              <small>ID: \${wf.id}</small><br>
              <span class="status-badge \${statusClass}">\${statusText.toUpperCase()}</span>
              \${wf.state?.resumeAt ? '<br><small>Resumes: ' + new Date(wf.state.resumeAt).toLocaleString() + '</small>' : ''}
            </div>
            <div>
              <button class="btn" onclick="executeWorkflow('\${wf.id}')">▶ Execute</button>
              <button class="btn btn-secondary" onclick="viewWorkflow('\${wf.id}')">👁 View</button>
              <button class="btn btn-danger" onclick="deleteWorkflow('\${wf.id}')">🗑 Delete</button>
            </div>
          </li>
        \`;
      }).join('');
    }
    
    // Execute workflow
    async function executeWorkflow(workflowId) {
      try {
        const response = await fetch(\`\${API_BASE}/api/workflows/\${workflowId}/execute\`, {
          method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success) {
          alert(result.message || 'Workflow executed!');
          loadWorkflows();
        } else {
          alert('Error: ' + result.error);
        }
      } catch (error) {
        alert('Error executing workflow: ' + error.message);
      }
    }
    
    // View workflow details
    async function viewWorkflow(workflowId) {
      try {
        const response = await fetch(\`\${API_BASE}/api/workflows/\${workflowId}\`);
        const result = await response.json();
        
        if (result.success) {
          showWorkflowDetails(result.workflow);
        }
      } catch (error) {
        alert('Error loading workflow details');
      }
    }
    
    // Show workflow details
    function showWorkflowDetails(workflow) {
      const detailsDiv = document.getElementById('workflowDetails');
      const contentDiv = document.getElementById('workflowDetailsContent');
      
      const nodeTypes = {
        http: '🌐 HTTP Request',
        loop: '🔁 Loop',
        telegram: '📱 Telegram',
        wait: '⏳ Wait',
        schedule: '⏰ Schedule'
      };
      
      const nodeClasses = {
        http: 'node-http',
        loop: 'node-loop',
        telegram: 'node-telegram',
        wait: 'node-wait',
        schedule: 'node-schedule'
      };
      
      let logOutput = '';
      if (workflow.state?.steps && workflow.state.steps.length > 0) {
        logOutput = '<h3>Execution Log:</h3><div class="log-output">' + 
          workflow.state.steps.map(step => {
            const time = new Date(step.timestamp).toLocaleTimeString();
            return \`[\${time}] \${step.nodeType.toUpperCase()}: \${JSON.stringify(step.result).substring(0, 100)}...\`;
          }).join('<br>') + '</div>';
      }
      
      contentDiv.innerHTML = \`
        <h3>\${workflow.name}</h3>
        <p><strong>Status:</strong> \${workflow.state?.status || 'idle'}</p>
        <p><strong>Created:</strong> \${new Date(workflow.createdAt).toLocaleString()}</p>
        \${workflow.state?.resumeAt ? '<p><strong>Resumes at:</strong> ' + new Date(workflow.state.resumeAt).toLocaleString() + '</p>' : ''}
        
        <h4>Workflow Nodes:</h4>
        <div class="node-visual">
          \${workflow.nodes.map((node, i) => \`
            <div class="node-box \${nodeClasses[node.type] || ''}">
              \${nodeTypes[node.type] || node.type}
            </div>
            \${i < workflow.nodes.length - 1 ? '<span class="arrow">→</span>' : ''}
          \`).join('')}
        </div>
        
        \${logOutput}
        
        <div style="margin-top: 20px;">
          <button class="btn" onclick="executeWorkflow('\${workflow.id}')">▶ Execute Now</button>
          <button class="btn btn-secondary" onclick="document.getElementById('workflowDetails').classList.add('hidden')">Close</button>
        </div>
      \`;
      
      detailsDiv.classList.remove('hidden');
      detailsDiv.scrollIntoView({ behavior: 'smooth' });
    }
    
    // Delete workflow
    async function deleteWorkflow(workflowId) {
      if (!confirm('Are you sure you want to delete this workflow?')) return;
      
      try {
        const response = await fetch(\`\${API_BASE}/api/workflows/\${workflowId}\`, {
          method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
          alert('Workflow deleted!');
          loadWorkflows();
          document.getElementById('workflowDetails').classList.add('hidden');
        } else {
          alert('Error: ' + result.error);
        }
      } catch (error) {
        alert('Error deleting workflow: ' + error.message);
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html'
    }
  });
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}
