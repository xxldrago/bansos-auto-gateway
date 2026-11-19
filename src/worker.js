// Cloudflare Worker to proxy Telegram Bot API requests
// This allows running the open-source opencode-telegram-bot locally

const TELEGRAM_USER_ID = '902227074';
const TELEGRAM_API_URL = 'https://api.telegram.org/bot9132746823:AAHrOAqP9i_gQKPBffzxOHYQwdRNPcyGk7Q';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  
  // Route to /api/:method/:rest
  if (url.pathname === '/api/:method/*') {
    const parts = url.pathname.slice('/api/'.length, url.pathname.length);
    if (!parts) return new Response('Invalid route', { status: 400 });
    
    const [method, ...args] = parts.split('/');
    const fullPath = '/' + args.join('/');
    const body = await request.clone().text();
    
    try {
      const response = await fetch(`${TELEGRAM_API_URL}/${method}${fullPath}`, {
        method: request.method,
        headers: request.headers,
        body: body ? body : null
      });
      
      const buffer = await response.arrayBuffer();
      return new Response(buffer, {
        status: response.status,
        headers: Object.fromEntries(response.headers)
      });
    } catch (e) {
      return new Response('Telegram API error: ' + e.message, { status: 500 });
    }
  }
  
  // Health check endpoint
  if (url.pathname === '/health') {
    return new Response(JSON.stringify({ status: 'ok' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  // Default route
  return new Response('Cloudflare Worker: Telegram Bot Proxy', {
    headers: { 'Content-Type': 'text/html' }
  });
}

export default {
  async fetch(request) {
    return handleRequest(request);
  }
};
