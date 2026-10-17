// Local development adapter; never uses hosted database credentials.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function createPreviewStore(container) {
  const execute = promisify(execFile);
  if (!/^trustbunny-[a-z0-9-]+$/.test(container || ""))
    throw new Error(
      "TV_PREVIEW_CONTAINER must name an isolated trustbunny-* test container.",
    );
  const literal = (v) =>
    v === null
      ? "NULL"
      : `'${(typeof v === "object" ? JSON.stringify(v) : String(v)).replaceAll("'", "''")}'`;
  const identifier = (s) => {
    if (!/^[a-z_]+$/.test(s)) throw new Error("Invalid identifier");
    return `"${s}"`;
  };
  async function sql(statement) {
    try {
      const { stdout } = await execute(
        "docker",
        [
          "exec",
          container,
          "psql",
          "-U",
          "postgres",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          statement,
        ],
        { maxBuffer: 5_000_000 },
      );
      return stdout.trim() ? JSON.parse(stdout.trim()) : null;
    } catch (error) {
      const failure = new Error(
        "Isolated test database rejected the operation",
      );
      failure.code = "P0001";
      // Only test database messages, never app request payloads.
      console.error(String(error.stderr || "Database error").slice(0, 500));
      throw failure;
    }
  }
  const where = (values) =>
    Object.entries(values)
      .map(
        ([k, v]) =>
          `${identifier(k)} ${v === null ? "IS NULL" : "= " + literal(v)}`,
      )
      .join(" AND ") || "true";
  const store = {
    async find(table, filters = {}, options = {}) {
      const order = options.order
        ? `ORDER BY ${identifier(options.order)} ${options.ascending ? "ASC" : "DESC"}`
        : "";
      return sql(
        `SELECT coalesce(jsonb_agg(x),'[]') FROM (SELECT * FROM ${identifier(table)} WHERE ${where(filters)} ${order} LIMIT ${Number(options.limit || 200)}) x`,
      );
    },
    async one(table, filters = {}) {
      return (await this.find(table, filters, { limit: 1 }))[0] || null;
    },
    async insert(table, data) {
      const fields = Object.keys(data);
      return (
        await sql(
          `WITH x AS (INSERT INTO ${identifier(table)} (${fields.map(identifier).join(",")}) VALUES (${fields.map((k) => `(jsonb_populate_record(null::${identifier(table)},${literal(data)})).${identifier(k)}`).join(",")}) RETURNING *) SELECT jsonb_agg(x) FROM x`,
        )
      )[0];
    },
    async update(table, filters, data) {
      return sql(
        `WITH x AS (UPDATE ${identifier(table)} SET ${Object.keys(data)
          .map(
            (k) =>
              `${identifier(k)}=(jsonb_populate_record(null::${identifier(table)},${literal(data)})).${identifier(k)}`,
          )
          .join(
            ",",
          )} WHERE ${where(filters)} RETURNING *) SELECT coalesce(jsonb_agg(x),'[]') FROM x`,
      );
    },
    async remove(table, filters) {
      return sql(
        `WITH x AS (DELETE FROM ${identifier(table)} WHERE ${where(filters)} RETURNING *) SELECT coalesce(jsonb_agg(x),'[]') FROM x`,
      );
    },
    async rpc(name, args = {}) {
      const argument = (key, value) => {
        // This RPC takes uuid[], while object-valued arguments elsewhere are jsonb.
        if (name === "tv_forget_proofs" && key === "p_proof_ids") {
          if (!Array.isArray(value))
            throw new Error("Proof IDs must be an array");
          return `ARRAY[${value.map(literal).join(",")}]::uuid[]`;
        }
        return literal(value);
      };
      return sql(
        `SELECT to_jsonb(${identifier(name)}(${Object.entries(args)
          .map(([k, v]) => `${identifier(k)}=>${argument(k, v)}`)
          .join(",")}))`,
      );
    },
  };
  return store;
}
