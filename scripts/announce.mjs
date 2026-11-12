// Posts a release announcement to Discord and/or Bluesky.
// Used by .github/workflows/release.yml; each channel is skipped unless its
// secrets are set. Usage: node scripts/announce.mjs <release-notes-file>
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const notesFile = process.argv[2];
const notes = notesFile ? readFileSync(notesFile, "utf8") : "";

const version = pkg.version;
const releaseUrl = `${pkg.homepage}/releases/tag/v${version}`;

// First few bullet points of the changelog, stripped of markdown.
const highlights = notes
  .split("\n")
  .filter((line) => /^\s*[-*]\s+/.test(line))
  .map((line) => line.replace(/^\s*[-*]\s+/, "").replace(/\*\*|`/g, "").trim())
  .slice(0, 3);

async function discord() {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return console.log("Discord: skipped (no DISCORD_WEBHOOK_URL)");
  const content = [
    `**devpulse-mcp v${version}** is out`,
    ...highlights.map((h) => `- ${h}`),
    releaseUrl,
  ].join("\n");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  if (!res.ok) throw new Error(`Discord: ${res.status} ${await res.text()}`);
  console.log("Discord: posted");
}

async function bluesky() {
  const identifier = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!identifier || !password) return console.log("Bluesky: skipped (no BLUESKY_HANDLE / BLUESKY_APP_PASSWORD)");

  const session = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!session.ok) throw new Error(`Bluesky login: ${session.status} ${await session.text()}`);
  const { accessJwt, did } = await session.json();

  const head = `devpulse-mcp v${version}: your AI coding assistant can see what's wrong with your dev environment in one call.`;
  const middle = highlights.length > 0 ? `\n\nNew: ${highlights[0]}` : "";
  const maxMiddle = 300 - head.length - releaseUrl.length - 4;
  const text = `${head}${middle.slice(0, Math.max(0, maxMiddle))}\n\n${releaseUrl}`;

  // Links are only clickable on Bluesky with a facet giving their byte range.
  const encoder = new TextEncoder();
  const byteStart = encoder.encode(text.slice(0, text.lastIndexOf(releaseUrl))).length;
  const byteEnd = byteStart + encoder.encode(releaseUrl).length;

  const post = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessJwt}` },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date().toISOString(),
        facets: [
          {
            index: { byteStart, byteEnd },
            features: [{ $type: "app.bsky.richtext.facet#link", uri: releaseUrl }],
          },
        ],
      },
    }),
  });
  if (!post.ok) throw new Error(`Bluesky post: ${post.status} ${await post.text()}`);
  console.log("Bluesky: posted");
}

// An announcement failure should never fail the release itself.
for (const channel of [discord, bluesky]) {
  try {
    await channel();
  } catch (error) {
    console.log(`::warning::${error.message}`);
  }
}
