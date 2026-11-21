import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export interface StateStore<State> {
  read(): State;
  update<Result>(change: (draft: State) => Result): Result;
}

export class MemoryStateStore<State> implements StateStore<State> {
  private state: State;

  constructor(initial: State) {
    this.state = structuredClone(initial);
  }

  read(): State {
    return structuredClone(this.state);
  }

  update<Result>(change: (draft: State) => Result): Result {
    const draft = this.read();
    const result = change(draft);
    this.state = structuredClone(draft);
    return result;
  }
}

// The file adapter has one writer. Multi-process deployments supply a transactional store.
export class FileStateStore<State> implements StateStore<State> {
  constructor(
    private readonly path: string,
    initial: State,
  ) {
    if (!existsSync(path)) {
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
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, json);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
  }
}
