export default async function handler(req, res) {
  const pathParts = req.query.path || [];
  const path = Array.isArray(pathParts) ? pathParts.join('/') : pathParts;

  const query = { ...req.query };
  delete query.path;
  const queryString = new URLSearchParams(query).toString();

  const targetUrl = `https://apis.data.go.kr/1613000/nsdi/LandUseService/wfs/${path}${queryString ? '?' + queryString : ''}`;

  try {
    const response = await fetch(targetUrl);
    const text = await response.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.status(response.status).send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
