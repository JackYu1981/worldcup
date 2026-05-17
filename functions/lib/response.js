const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function json(data, status = 200, cacheSeconds = 0) {
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function error(message, status = 500) {
  return json({ error: message }, status);
}

export function options() {
  return new Response(null, { headers: corsHeaders });
}
