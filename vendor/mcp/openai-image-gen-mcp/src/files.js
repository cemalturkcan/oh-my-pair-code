import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, resolve, dirname, join } from "node:path";
import { homedir } from "node:os";

const INPUT_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const OUTPUT_EXTENSIONS = {
  png: ".png",
  jpeg: ".jpg",
  webp: ".webp",
};

export function defaultOutputDir(fallbackDir) {
  return fallbackDir || join(homedir(), ".codex", "generated_images");
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function ensureAbsolutePath(filePath, baseDir, kind, fallbackOutputDir) {
  const normalized = normalizeNonEmptyString(filePath);
  if (!normalized) {
    throw new Error(`'${kind}' must be a non-empty string.`);
  }

  if (isAbsolute(normalized)) {
    return resolve(normalized);
  }

  if (baseDir) {
    return resolve(baseDir, normalized);
  }

  if (kind === "output_path") {
    return resolve(defaultOutputDir(fallbackOutputDir), normalized);
  }

  throw new Error(
    `'${kind}' must be an absolute path, or provide 'base_dir' so relative paths can be resolved.`,
  );
}

export function resolveBaseDir(baseDir) {
  const normalized = normalizeNonEmptyString(baseDir);
  return normalized ? resolve(normalized) : null;
}

export function readInputImageAsDataUrl(filePath, baseDir) {
  const absolutePath = ensureAbsolutePath(filePath, baseDir, "input_images");
  const extension = extname(absolutePath).toLowerCase();
  const mimeType = INPUT_MIME_TYPES[extension];
  if (!mimeType) {
    throw new Error(
      `Unsupported input image type '${extension || "<none>"}' for ${absolutePath}. Use png, jpg, jpeg, webp, or gif.`,
    );
  }

  const bytes = readFileSync(absolutePath);
  return {
    absolutePath,
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
  };
}

function extensionForFormat(outputFormat) {
  return OUTPUT_EXTENSIONS[outputFormat] || ".png";
}

function slugifyPrompt(prompt) {
  const value = normalizeNonEmptyString(prompt);
  if (!value) {
    return "image";
  }

  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "image";
}

function hashPrompt(prompt) {
  const value = normalizeNonEmptyString(prompt) || "image";
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function resolveOutputName(outputName) {
  const normalized = normalizeNonEmptyString(outputName);
  if (!normalized) {
    return null;
  }

  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("'output_name' must be a file name, not a path.");
  }

  if (normalized === "." || normalized === "..") {
    throw new Error("'output_name' must not be '.' or '..'.");
  }

  return normalized;
}

function withExtension(filePath, extension) {
  return extname(filePath) ? filePath : `${filePath}${extension}`;
}

function replaceExtension(filePath, extension) {
  const currentExtension = extname(filePath);
  if (!currentExtension) {
    return `${filePath}${extension}`;
  }

  return `${filePath.slice(0, -currentExtension.length)}${extension}`;
}

export function resolveOutputPaths({
  outputPath,
  outputName,
  baseDir,
  prompt,
  outputFormat,
  count,
  defaultOutputDir: configuredOutputDir,
}) {
  const safeCount = Math.max(1, Number.isFinite(count) ? count : 1);
  const extension = extensionForFormat(outputFormat);

  if (outputPath) {
    const absoluteTarget = ensureAbsolutePath(
      outputPath,
      baseDir,
      "output_path",
      configuredOutputDir,
    );
    if (safeCount === 1) {
      return [replaceExtension(withExtension(absoluteTarget, extension), extension)];
    }

    const targetExtension = extname(absoluteTarget);
    const baseTarget = targetExtension
      ? absoluteTarget.slice(0, -targetExtension.length)
      : absoluteTarget;
    const finalExtension = extension;

    return Array.from({ length: safeCount }, (_, index) =>
      `${baseTarget}-${index + 1}${finalExtension}`,
    );
  }

  const resolvedOutputName = resolveOutputName(outputName);

  if (resolvedOutputName) {
    const dir = baseDir || defaultOutputDir(configuredOutputDir);
    const namedTarget = resolve(dir, resolvedOutputName);
    if (safeCount === 1) {
      return [replaceExtension(withExtension(namedTarget, extension), extension)];
    }

    const targetExtension = extname(namedTarget);
    const baseTarget = targetExtension
      ? namedTarget.slice(0, -targetExtension.length)
      : namedTarget;

    return Array.from({ length: safeCount }, (_, index) =>
      `${baseTarget}-${index + 1}${extension}`,
    );
  }

  if (!outputPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = baseDir || defaultOutputDir(configuredOutputDir);
    const slug = slugifyPrompt(prompt);
    const promptHash = hashPrompt(prompt);
    return Array.from({ length: safeCount }, (_, index) =>
      resolve(
        dir,
        `${slug}-${promptHash}-${stamp}${safeCount > 1 ? `-${index + 1}` : ""}${extension}`,
      ),
    );
  }

  throw new Error("Unable to resolve an output path.");
}

export function writeBase64Image(filePath, base64Data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.from(base64Data, "base64"));
}
