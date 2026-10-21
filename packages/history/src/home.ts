import { join } from "node:path";

export class Home {
  constructor(
    readonly dir: string,
    private readonly env: Record<string, string | undefined> = {},
  ) {}

  static fromEnv(): Home | null {
    const dir = process.env.HOME;
    return dir ? new Home(dir, process.env) : null;
  }

  withVar(key: string, value: string): Home {
    return new Home(this.dir, { ...this.env, [key]: value });
  }

  pathFrom(variable: string, fallback: string): string {
    const value = this.env[variable];
    return value ? value : join(this.dir, fallback);
  }
}
