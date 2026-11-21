import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { StateStore } from "./state-store.js";

// File updates are synchronous with a single writer process.
export class FileStateStore<State> implements StateStore<State> {
  private readonly path: string;

  constructor(path: string, initial: State) {
    this.path = resolve(path);
    if (!existsSync(this.path)) {
      this.persist(JSON.stringify(initial));
    }
  }

  read(): State {
    return JSON.parse(readFileSync(this.path, "utf8")) as State;
  }

  update<Result>(change: (draft: State) => Result): Result {
    const original = readFileSync(this.path, "utf8");
    const draft = JSON.parse(original) as State;
    const result = change(draft);
    const next = JSON.stringify(draft);
    if (next !== original) {
      this.persist(next);
    }
    return result;
  }

  private persist(json: string) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(file, json);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }

    // Windows cannot open a directory with Node's file APIs for fsync.
    if (process.platform !== "win32") {
      const directory = openSync(dirname(this.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }
}
