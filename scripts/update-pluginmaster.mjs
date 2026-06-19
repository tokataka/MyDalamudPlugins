import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const pluginmasterPath = path.join(repoRoot, "pluginmaster.json");
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!eventPath) {
  throw new Error("GITHUB_EVENT_PATH is not set.");
}

const event = JSON.parse(stripBom(await readFile(eventPath, "utf8")));
const entries = await readPluginmaster();
const payload = event.client_payload;

switch (event.action) {
  case "plugin-release":
    await updatePluginReleases(payload);
    break;

  case "plugin-download-count":
    updateDownloadCounts(payload);
    break;

  default:
    console.log("No repository_dispatch action was provided. Rewriting pluginmaster from existing data.");
    break;
}

await writePluginmaster(entries);

async function readPluginmaster() {
  try {
    const content = stripBom(await readFile(pluginmasterPath, "utf8"));
    if (!content.trim()) {
      return [];
    }

    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, "");
}

async function writePluginmaster(value) {
  value.sort((left, right) => left.InternalName.localeCompare(right.InternalName));
  await writeFile(pluginmasterPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readPluginPayloads(payload, eventName) {
  if (!payload || !Array.isArray(payload.plugins) || payload.plugins.length === 0) {
    throw new Error(`${eventName} dispatch requires client_payload.plugins.`);
  }

  return payload.plugins;
}

async function updatePluginReleases(payload) {
  for (const pluginPayload of readPluginPayloads(payload, "plugin-release")) {
    await updatePluginRelease(pluginPayload);
  }
}

async function updatePluginRelease(releasePayload) {
  const manifest = releasePayload.manifest ?? {};
  const release = releasePayload.release ?? {};
  const source = releasePayload.source ?? {};
  const internalName = String(releasePayload.internal_name ?? "").trim();
  const version = String(releasePayload.version ?? "").trim();

  if (!internalName) {
    throw new Error("plugin-release payload requires internal_name.");
  }

  if (!version) {
    throw new Error(`plugin-release payload for '${internalName}' requires version.`);
  }

  if (!manifest.metadata_url) {
    throw new Error(`plugin-release payload for '${internalName}' requires manifest.metadata_url.`);
  }

  if (!release.zip_url) {
    throw new Error(`plugin-release payload for '${internalName}' requires release.zip_url.`);
  }

  const metadata = await readJsonFromUrl(manifest.metadata_url);
  const existingIndex = entries.findIndex((entry) => entry.InternalName === internalName);
  const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
  const nextEntry = {
    Author: metadata.Author,
    Name: metadata.Name,
    Punchline: metadata.Punchline,
    Description: metadata.Description,
    InternalName: internalName,
    AssemblyVersion: version,
    RepoUrl: source.repository_url ?? metadata.RepoUrl ?? "",
    ApplicableVersion: metadata.ApplicableVersion ?? "any",
    DalamudApiLevel: Number(manifest.dalamud_api_level ?? 15),
    DownloadCount: Number(existing?.DownloadCount ?? 0),
    LastUpdate: Math.floor(Date.now() / 1000),
    DownloadLinkInstall: String(release.zip_url),
    DownloadLinkUpdate: String(release.zip_url),
    IconUrl: manifest.icon_url ?? "",
  };

  if (typeof releasePayload.changelog === "string" && releasePayload.changelog.trim()) {
    nextEntry.Changelog = releasePayload.changelog;
  }

  if (Array.isArray(metadata.Tags) && metadata.Tags.length > 0) {
    nextEntry.Tags = metadata.Tags;
  }

  if (existingIndex >= 0) {
    entries[existingIndex] = nextEntry;
  } else {
    entries.push(nextEntry);
  }
}

async function readJsonFromUrl(url) {
  if (String(url).startsWith("file://")) {
    return JSON.parse(stripBom(await readFile(fileURLToPath(url), "utf8")));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON from ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function updateDownloadCounts(payload) {
  for (const pluginPayload of readPluginPayloads(payload, "plugin-download-count")) {
    updateDownloadCount(pluginPayload);
  }
}

function updateDownloadCount(countPayload) {
  const internalName = String(countPayload.internal_name ?? "").trim();

  if (!internalName) {
    throw new Error("plugin-download-count payload requires internal_name.");
  }

  if (countPayload.download_count === undefined || countPayload.download_count === null) {
    throw new Error(`plugin-download-count payload for '${internalName}' requires download_count.`);
  }

  const entry = entries.find((candidate) => candidate.InternalName === internalName);
  if (!entry) {
    throw new Error(`Plugin '${internalName}' was not found in pluginmaster.json.`);
  }

  const nextDownloadCount = Number(countPayload.download_count);
  if (Number(entry.DownloadCount) === nextDownloadCount) {
    console.log(`Download count for '${internalName}' is already ${nextDownloadCount}.`);
    return;
  }

  console.log(`Updating download count for '${internalName}': ${entry.DownloadCount} -> ${nextDownloadCount}.`);
  entry.DownloadCount = nextDownloadCount;
}
