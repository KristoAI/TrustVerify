export class StoreError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
export class SupabaseStore {
  constructor({ url, secret, anonKey }) {
    this.url = url;
    this.secret = secret;
    this.anonKey = anonKey;
  }
  async call(body) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.anonKey}`,
        "x-tv-server-key": this.secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || result.error)
      throw new StoreError(result.error || "Database unavailable", result.code);
    return result.data;
  }
  filters(where) {
    return Object.entries(where).map(([k, v]) => [
      k,
      v === null ? "is" : "eq",
      v,
    ]);
  }
  find(table, where = {}, options = {}) {
    return this.call({
      op: "select",
      table,
      filters: this.filters(where),
      ...options,
    });
  }
  async one(table, where = {}) {
    return (await this.find(table, where, { limit: 1 }))[0] || null;
  }
  async insert(table, data) {
    return (await this.call({ op: "insert", table, data }))[0];
  }
  update(table, where, data) {
    return this.call({
      op: "update",
      table,
      filters: this.filters(where),
      data,
    });
  }
  remove(table, where) {
    return this.call({ op: "delete", table, filters: this.filters(where) });
  }
  rpc(name, args = {}) {
    return this.call({ op: "rpc", name, args });
  }
}
