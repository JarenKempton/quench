import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "@quench/fleet";

export class ClickHouseError extends Error {}

const MiB = 1024 * 1024;
export const DEFAULT_MEMORY = 2560 * MiB;

export type Params = Record<string, string | number>;

export class ClickHouse {
  constructor(
    readonly url: string,
    private readonly user: string,
    private readonly password: string,
    readonly database = "quench",
  ) {}

  private async send(query: URLSearchParams, body: string | Uint8Array) {
    const response = await fetch(`${this.url}/?${query.toString()}`, {
      method: "POST",
      body,
      headers: { "x-clickhouse-user": this.user, "x-clickhouse-key": this.password },
    });
    const text = await response.text();
    if (!response.ok) throw new ClickHouseError(text.trim().slice(0, 600));
    return text;
  }

  exec(sql: string, params: Params = {}, settings: Params = {}) {
    const query = new URLSearchParams({ database: this.database });
    for (const [k, v] of Object.entries(params)) query.set(`param_${k}`, String(v));
    for (const [k, v] of Object.entries(settings)) query.set(k, String(v));
    return this.send(query, sql);
  }

  async rows<T = Record<string, unknown>>(sql: string, params: Params = {}, settings: Params = {}) {
    const text = await this.exec(`${sql}\nFORMAT JSONEachRow`, params, {
      output_format_json_quote_64bit_integers: 0,
      ...settings,
    });
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }

  async insert(table: string, rows: readonly object[]) {
    if (!rows.length) return;
    const query = new URLSearchParams({
      database: this.database,
      query: `INSERT INTO ${table} FORMAT JSONEachRow`,
      async_insert: "1",
      wait_for_async_insert: "1",
      date_time_input_format: "best_effort",
    });
    await this.send(query, rows.map((row) => JSON.stringify(row)).join("\n"));
  }

  async ping() {
    const response = await fetch(`${this.url}/ping`).catch(() => null);
    return response?.ok === true;
  }
}

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function serverConfig(dir: string, port: number, memory: number) {
  const d = xml(dir);
  return `<clickhouse>
  <logger>
    <level>warning</level>
    <log>${d}/log/clickhouse.log</log>
    <errorlog>${d}/log/clickhouse.err.log</errorlog>
    <size>50M</size>
    <count>3</count>
    <console>0</console>
  </logger>
  <timezone>UTC</timezone>
  <listen_host>127.0.0.1</listen_host>
  <http_port>${port}</http_port>
  <keep_alive_timeout>2</keep_alive_timeout>
  <shutdown_wait_unfinished>2</shutdown_wait_unfinished>
  <path>${d}/data/</path>
  <tmp_path>${d}/tmp/</tmp_path>
  <user_files_path>${d}/user_files/</user_files_path>
  <format_schema_path>${d}/format_schemas/</format_schema_path>
  <user_directories><users_xml><path>${d}/etc/users.xml</path></users_xml></user_directories>
  <max_server_memory_usage>${memory}</max_server_memory_usage>
  <mark_cache_size>${256 * MiB}</mark_cache_size>
  <index_mark_cache_size>${64 * MiB}</index_mark_cache_size>
  <uncompressed_cache_size>0</uncompressed_cache_size>
  <primary_index_cache_size>${64 * MiB}</primary_index_cache_size>
  <mmap_cache_size>256</mmap_cache_size>
  <background_pool_size>4</background_pool_size>
  <background_merges_mutations_concurrency_ratio>1</background_merges_mutations_concurrency_ratio>
  <background_schedule_pool_size>16</background_schedule_pool_size>
  <background_common_pool_size>4</background_common_pool_size>
  <background_move_pool_size>1</background_move_pool_size>
  <background_fetches_pool_size>1</background_fetches_pool_size>
  <background_buffer_flush_schedule_pool_size>1</background_buffer_flush_schedule_pool_size>
  <background_message_broker_schedule_pool_size>1</background_message_broker_schedule_pool_size>
  <background_distributed_schedule_pool_size>1</background_distributed_schedule_pool_size>
  <max_thread_pool_size>500</max_thread_pool_size>
  <max_concurrent_queries>16</max_concurrent_queries>
  <mlock_executable>false</mlock_executable>
  <merge_tree>
    <merge_max_block_size>1024</merge_max_block_size>
    <max_bytes_to_merge_at_max_space_in_pool>${1024 * MiB}</max_bytes_to_merge_at_max_space_in_pool>
    <number_of_free_entries_in_pool_to_lower_max_size_of_merge>2</number_of_free_entries_in_pool_to_lower_max_size_of_merge>
    <number_of_free_entries_in_pool_to_execute_mutation>2</number_of_free_entries_in_pool_to_execute_mutation>
    <number_of_free_entries_in_pool_to_execute_optimize_entire_partition>2</number_of_free_entries_in_pool_to_execute_optimize_entire_partition>
  </merge_tree>
  <query_log>
    <database>system</database>
    <table>query_log</table>
    <ttl>event_date + INTERVAL 30 DAY DELETE</ttl>
    <flush_interval_milliseconds>7500</flush_interval_milliseconds>
  </query_log>
  <part_log>
    <database>system</database>
    <table>part_log</table>
    <ttl>event_date + INTERVAL 30 DAY DELETE</ttl>
    <flush_interval_milliseconds>7500</flush_interval_milliseconds>
  </part_log>
</clickhouse>
`;
}

export function usersConfig(password: string, memory: number) {
  const query = Math.floor(memory * 0.6);
  const spill = Math.floor(query / 3);
  return `<clickhouse>
  <profiles>
    <default>
      <max_threads>2</max_threads>
      <max_memory_usage>${query}</max_memory_usage>
      <max_bytes_before_external_group_by>${spill}</max_bytes_before_external_group_by>
      <max_bytes_before_external_sort>${spill}</max_bytes_before_external_sort>
      <async_insert_max_data_size>${10 * MiB}</async_insert_max_data_size>
      <log_queries>1</log_queries>
    </default>
  </profiles>
  <users>
    <quench>
      <password_sha256_hex>${sha256(password)}</password_sha256_hex>
      <networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
    </quench>
  </users>
  <quotas><default/></quotas>
</clickhouse>
`;
}

export type Supervised = { url: string; stop(): Promise<void> };

async function privateDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${path} must be a real folder, not a link or file`);
  if (process.getuid && info.uid !== process.getuid())
    throw new Error(`${path} must be owned by the user running the hub`);
}

export async function superviseClickHouse(options: {
  bin: string;
  dir: string;
  port: number;
  password: string;
  memory: number;
  log?: (line: string) => void;
}): Promise<Supervised> {
  await privateDir(options.dir);
  for (const sub of ["etc", "log", "data", "tmp"]) await privateDir(join(options.dir, sub));
  const config = join(options.dir, "etc", "config.xml");
  await writeFile(config, serverConfig(options.dir, options.port, options.memory), {
    mode: 0o600,
  });
  await writeFile(
    join(options.dir, "etc", "users.xml"),
    usersConfig(options.password, options.memory),
    { mode: 0o600 },
  );
  const url = `http://127.0.0.1:${options.port}`;
  const probe = new ClickHouse(url, "quench", options.password);
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  let backoff = 1000;
  const start = () => {
    child = Bun.spawn([options.bin, "server", `--config-file=${config}`], {
      cwd: options.dir,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const mine = child;
    void mine.exited.then(async (code) => {
      if (stopping) return;
      const err = await new Response(mine.stderr as ReadableStream).text().catch(() => "");
      options.log?.(
        `clickhouse exited with ${code}; restarting in ${backoff / 1000}s ${err.slice(-400)}`,
      );
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      if (!stopping) start();
    });
  };
  start();
  const deadline = Date.now() + 90_000;
  while (!(await probe.ping())) {
    if (Date.now() > deadline) {
      stopping = true;
      (child as ReturnType<typeof Bun.spawn> | null)?.kill("SIGKILL");
      throw new ClickHouseError(
        `clickhouse did not answer on ${url} within 90s; see ${join(options.dir, "log")}`,
      );
    }
    await Bun.sleep(200);
  }
  backoff = 1000;
  return {
    url,
    async stop() {
      stopping = true;
      const running = child as ReturnType<typeof Bun.spawn> | null;
      if (!running) return;
      running.kill("SIGTERM");
      const done = await Promise.race([
        running.exited.then(() => true),
        Bun.sleep(30_000).then(() => false),
      ]);
      if (!done) {
        running.kill("SIGKILL");
        await running.exited;
      }
    },
  };
}
