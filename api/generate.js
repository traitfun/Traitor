export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, style, collectionName, nftId } = req.body;

  if (!prompt && !collectionName) {
    return res.status(400).json({ error: 'prompt or collectionName required' });
  }

  try {
    // ================================================
    // STEP 1: Generate image via fal.ai (FLUX Schnell)
    // ================================================
    const fullPrompt = [
      collectionName || prompt,
      style ? `${style} style` : 'digital art style',
      'NFT profile picture, detailed, vibrant colors, high quality, trending on opensea'
    ].join(', ');

    const falRes = await fetch('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${process.env.FAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: fullPrompt,
        image_size: 'square_hd',
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      })
    });

    if (!falRes.ok) {
      const err = await falRes.text();
      console.error('fal.ai error:', err);
      return res.status(500).json({ error: 'Image generation failed', detail: err });
    }

    const falData = await falRes.json();
    const imageUrl = falData.images?.[0]?.url;

    if (!imageUrl) {
      return res.status(500).json({ error: 'No image returned from fal.ai' });
    }

    // ================================================
    // STEP 2: Download image buffer
    // ================================================
    const imageRes = await fetch(imageUrl);
    if (!imageRes.ok) {
      return res.status(500).json({ error: 'Failed to download generated image' });
    }
    const imageBuffer = await imageRes.arrayBuffer();

    // ================================================
    // STEP 3: Upload image to Pinata (IPFS)
    // ================================================
    const fileName = `${(collectionName || 'nft').replace(/\s+/g, '-').toLowerCase()}-${nftId || Date.now()}.png`;

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([imageBuffer], { type: 'image/png' }),
      fileName
    );
    formData.append('pinataMetadata', JSON.stringify({
      name: fileName,
      keyvalues: {
        collection: collectionName || 'unknown',
        nftId: String(nftId || ''),
      }
    }));
    formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

    const pinataRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PINATA_JWT}`,
      },
      body: formData
    });

    if (!pinataRes.ok) {
      const err = await pinataRes.text();
      console.error('Pinata error:', err);
      // Fallback: return fal.ai URL directly if Pinata fails
      return res.status(200).json({
        imageUrl,
        ipfsUrl: null,
        source: 'fal-direct',
        nftId,
      });
    }

    const pinataData = await pinataRes.json();
    const ipfsHash = pinataData.IpfsHash;
    const ipfsUrl = `https://gateway.pinata.cloud/ipfs/${ipfsHash}`;

    // ================================================
    // STEP 4: Upload metadata JSON to Pinata
    // ================================================
    const metadata = {
      name: `${collectionName} #${nftId}`,
      description: `NFT #${nftId} from the ${collectionName} collection on BANKRMINT`,
      image: ipfsUrl,
      attributes: [
        { trait_type: 'Collection', value: collectionName },
        { trait_type: 'Style', value: style || 'Digital Art' },
        { trait_type: 'Token ID', value: nftId },
      ]
    };

    const metaFormData = new FormData();
    metaFormData.append(
      'file',
      new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' }),
      `${fileName.replace('.png', '')}-metadata.json`
    );
    metaFormData.append('pinataMetadata', JSON.stringify({ name: `${fileName}-metadata` }));

    const metaRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.PINATA_JWT}` },
      body: metaFormData
    });

    let metadataUrl = null;
    if (metaRes.ok) {
      const metaData = await metaRes.json();
      metadataUrl = `https://gateway.pinata.cloud/ipfs/${metaData.IpfsHash}`;
    }

    // ================================================
    // DONE — return everything
    // ================================================
    return res.status(200).json({
      imageUrl: ipfsUrl,
      metadataUrl,
      ipfsHash,
      nftId,
      source: 'ipfs',
    });

  } catch (err) {
    console.error('generate handler error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
