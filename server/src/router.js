/** Minimal router: add('GET', '/api/cars/:id', handler). Handlers get (ctx) with params, query, req, res. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, regex, keys, handler });
  }

  match(method, path) {
    let pathMatched = false;
    // Exact paths win over ones with :params (so /api/clips/calendar isn't read as clip "calendar").
    const ordered = [...this.routes.filter((r) => !r.keys.length), ...this.routes.filter((r) => r.keys.length)];
    for (const r of ordered) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}
