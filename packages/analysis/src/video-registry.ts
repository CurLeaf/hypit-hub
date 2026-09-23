import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GeneratedVideoView } from "./shared.js";

export type VideoRegistryStats = {
  readonly totalVideos: number;
  readonly totalBuilds: number;
};

export type StoredGeneratedVideo = GeneratedVideoView & {
  readonly buildId: string;
  readonly buildStatus: string;
  readonly recordedAt: string;
};

const schema = `
CREATE TABLE IF NOT EXISTS generated_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id TEXT NOT NULL,
  output_name TEXT NOT NULL,
  display_name TEXT,
  file_path TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER,
  build_status TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(build_id, output_name)
);
CREATE INDEX IF NOT EXISTS idx_generated_videos_build_id ON generated_videos(build_id);
`;

function registryPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".hypit", "analysis", "generated-videos.sqlite");
}

export class VideoRegistry {
  private readonly database: DatabaseSync;

  constructor(workspaceRoot: string) {
    const path = registryPath(workspaceRoot);
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(schema);
  }

  syncBuildVideos(
    buildId: string,
    videos: readonly GeneratedVideoView[],
    buildStatus: string,
  ): void {
    const insert = this.database.prepare(`
      INSERT INTO generated_videos (
        build_id, output_name, display_name, file_path, media_type, size_bytes, build_status, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(build_id, output_name) DO UPDATE SET
        display_name = excluded.display_name,
        file_path = excluded.file_path,
        media_type = excluded.media_type,
        size_bytes = excluded.size_bytes,
        build_status = excluded.build_status,
        recorded_at = excluded.recorded_at
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const video of videos) {
        insert.run(
          buildId,
          video.name,
          video.displayName ?? null,
          video.path,
          video.mediaType,
          video.size ?? null,
          buildStatus,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  pruneMissingFiles(): number {
    const rows = this.database.prepare(
      "SELECT id, file_path FROM generated_videos",
    ).all() as Array<Record<string, unknown>>;
    const remove = this.database.prepare("DELETE FROM generated_videos WHERE id = ?");
    let removed = 0;
    for (const row of rows) {
      if (existsSync(String(row.file_path))) continue;
      remove.run(row.id);
      removed += 1;
    }
    return removed;
  }

  stats(): VideoRegistryStats {
    this.pruneMissingFiles();
    const videos = this.listAll();
    const buildIds = new Set(
      videos.map((video) => video.buildId).filter((buildId): buildId is string => buildId !== undefined),
    );
    return { totalVideos: videos.length, totalBuilds: buildIds.size };
  }

  listForBuild(buildId: string): readonly StoredGeneratedVideo[] {
    const rows = this.database.prepare(`
      SELECT build_id, output_name, display_name, file_path, media_type, size_bytes, build_status, recorded_at
      FROM generated_videos
      WHERE build_id = ?
      ORDER BY output_name ASC
    `).all(buildId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      buildId: String(row.build_id),
      name: String(row.output_name),
      ...(row.display_name === null || row.display_name === undefined
        ? {}
        : { displayName: String(row.display_name) }),
      path: String(row.file_path),
      mediaType: String(row.media_type),
      ...(row.size_bytes === null || row.size_bytes === undefined
        ? {}
        : { size: Number(row.size_bytes) }),
      buildStatus: String(row.build_status),
      recordedAt: String(row.recorded_at),
    }));
  }

  listExistingVideos(buildId: string, videos: readonly GeneratedVideoView[]): readonly GeneratedVideoView[] {
    const stored = this.listForBuild(buildId);
    if (stored.length === 0) return videos;
    const byName = new Map(videos.map((video) => [video.name, video]));
    for (const row of stored) {
      if (!existsSync(row.path)) continue;
      if (!byName.has(row.name)) byName.set(row.name, row);
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  listAll(): readonly GeneratedVideoView[] {
    const rows = this.database.prepare(`
      SELECT build_id, output_name, display_name, file_path, media_type, size_bytes, recorded_at
      FROM generated_videos
      ORDER BY recorded_at DESC, build_id ASC, output_name ASC
    `).all() as Array<Record<string, unknown>>;
    const byPath = new Map<string, GeneratedVideoView>();
    for (const row of rows) {
      const path = String(row.file_path);
      if (!existsSync(path) || byPath.has(path)) continue;
      byPath.set(path, {
        name: String(row.output_name),
        ...(row.display_name === null || row.display_name === undefined
          ? {}
          : { displayName: String(row.display_name) }),
        path,
        mediaType: String(row.media_type),
        ...(row.size_bytes === null || row.size_bytes === undefined
          ? {}
          : { size: Number(row.size_bytes) }),
        buildId: String(row.build_id),
        recordedAt: String(row.recorded_at),
      });
    }
    return [...byPath.values()];
  }

  close(): void {
    this.database.close();
  }
}

const registries = new Map<string, VideoRegistry>();

export function openVideoRegistry(workspaceRoot: string): VideoRegistry {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    throw new Error("workspaceRoot is required to open the video registry");
  }
  const key = resolve(workspaceRoot);
  const existing = registries.get(key);
  if (existing !== undefined) return existing;
  const registry = new VideoRegistry(key);
  registries.set(key, registry);
  return registry;
}
