const https = require('https');

function fetchJson(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ ok: res.statusCode < 300, status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, style, collectionName, nftId } = req.body || {};
  const FAL_API_KEY = process.env.FAL_API_KEY;
  const PINATA_JWT  = process.env.PINATA_JWT;

  if (!FAL_API_KEY) return res.status(500).json({ error: 'FAL_API_KEY not set' });
  if (!PINATA_JWT)  return res.status(500).json({ error: 'PINATA_JWT not set' });

  try {
    const fullPrompt = `${collectionName || prompt || 'NFT art'}, ${style || 'digital art'} style, NFT profile picture, vibrant colors, high quality`;

    const falResult = await fetchJson(
      'https://fal.run/fal-ai/flux/schnell',
      { method: 'POST', headers: { 'Authorization': `Key ${FAL_API_KEY}`, 'Content-Type': 'application/json' } },
      { prompt: fullPrompt, image_size: 'square_hd', num_inference_steps: 4, num_images: 1 }
    );

    if (!falResult.ok) {
      console.error('fal error:', falResult.data);
      return res.status(500).json({ error: 'fal.ai failed', detail: falResult.data });
    }

    const imageUrl = falResult.data?.images?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: 'No image from fal.ai' });

    const imageBuffer = await fetchBuffer(imageUrl);

    const boundary = '----Boundary' + Date.now();
    const fileName  = `${(collectionName||'nft').replace(/\s+/g,'-')}-${nftId||Date.now()}.png`;
    const formBody  = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const pinataResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.pinata.cloud',
        path: '/pinning/pinFileToIPFS',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PINATA_JWT}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': formBody.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ ok: res.statusCode < 300, data: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.write(formBody);
      req.end();
    });

    if (!pinataResult.ok) {
      console.error('Pinata error:', pinataResult.data);
      return res.status(200).json({ imageUrl, source: 'fal-direct', nftId });
    }

    const ipfsUrl = `https://gateway.pinata.cloud/ipfs/${pinataResult.data.IpfsHash}`;
    return res.status(200).json({ imageUrl: ipfsUrl, nftId, source: 'ipfs' });

  } catch (err) {
    console.error('error:', err);
    return res.status(500).json({ error: err.message });
  }
};
