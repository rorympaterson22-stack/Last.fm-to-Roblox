// lastfm-proxy.js  --  tiny image proxy for the Roblox Last.fm overhead GUI
//
// Why it exists: Roblox can't decode web images or judge whether an image is
// appropriate. This service downloads the album cover, checks it with an
// image-moderation API, shrinks it to 32x32 (blurring it if flagged) and returns
// the raw pixels as a hex string that the Roblox client draws into an EditableImage.
//
// Setup:
//   npm init -y && npm i express sharp
//   (add "type": "module" to package.json)
//   PROXY_SECRET=change-me SIGHTENGINE_USER=xxx SIGHTENGINE_SECRET=yyy node lastfm-proxy.js
//
// Host it anywhere that runs Node (Render, Railway, Fly.io, a VPS...).

import express from "express";
import sharp from "sharp";

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PROXY_SECRET;
const SE_USER = process.env.SIGHTENGINE_USER;
const SE_SECRET = process.env.SIGHTENGINE_SECRET;

const SIZE = 32;
const BLUR_SIZE = 4; // flagged covers are squashed to 4x4 and stretched back = heavy blur
const ALLOWED_HOSTS = new Set(["lastfm.freetls.fastly.net", "lastfm-img2.akamaized.net"]);

if (!SECRET) throw new Error("Set PROXY_SECRET");

const cache = new Map(); // url -> { pixels, blurred }

// Returns true if the image should be blurred. Fails CLOSED (blur) if moderation errors out.
// Sightengine's nudity-2.1 model: check their docs if field names change.
async function isInappropriate(imageUrl) {
  if (!SE_USER || !SE_SECRET) {
    console.warn("No moderation keys set - nothing will ever be blurred!");
    return false;
  }
  try {
    const qs = new URLSearchParams({
      url: imageUrl,
      models: "nudity-2.1,gore-2.0",
      api_user: SE_USER,
      api_secret: SE_SECRET,
    });
    const r = await fetch("https://api.sightengine.com/1.0/check.json?" + qs);
    const data = await r.json();
    if (data.status !== "success") return true;
    const n = data.nudity ?? {};
    const gore = data.gore?.prob ?? 0;
    return (
      (n.sexual_activity ?? 0) > 0.4 ||
      (n.sexual_display ?? 0) > 0.4 ||
      (n.erotica ?? 0) > 0.4 ||
      (n.very_suggestive ?? 0) > 0.6 ||
      gore > 0.5
    );
  } catch (err) {
    console.error("moderation error", err);
    return true;
  }
}

const app = express();

app.get("/cover", async (req, res) => {
  if (req.get("x-proxy-secret") !== SECRET) return res.status(401).json({ error: "unauthorized" });

  let url;
  try {
    url = new URL(String(req.query.url));
  } catch {
    return res.status(400).json({ error: "bad url" });
  }
  // Only fetch Last.fm's image CDN (prevents the proxy being abused to hit other sites)
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    return res.status(400).json({ error: "host not allowed" });
  }

  const cached = cache.get(url.href);
  if (cached) return res.json(cached);

  try {
    const r = await fetch(url.href);
    if (!r.ok) return res.status(502).json({ error: "image fetch failed" });
    const input = Buffer.from(await r.arrayBuffer());

    const flagged = await isInappropriate(url.href);

    const small = await sharp(input)
      .removeAlpha()
      .toColourspace("srgb")
      .resize(flagged ? BLUR_SIZE : SIZE, flagged ? BLUR_SIZE : SIZE, { fit: "cover" })
      .png()
      .toBuffer();

    const raw = await sharp(small)
      .resize(SIZE, SIZE, { kernel: "cubic" })
      .raw()
      .toBuffer(); // SIZE*SIZE*3 bytes, RGB

    const out = { pixels: raw.toString("hex"), blurred: flagged };
    if (cache.size > 500) cache.clear();
    cache.set(url.href, out);
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "processing failed" });
  }
});

app.listen(PORT, () => console.log("Last.fm cover proxy on :" + PORT));
