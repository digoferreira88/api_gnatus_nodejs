const fs = require("fs");
const path = require("path");
const pluralize = require("pluralize");

let options = {};

const mappedRoutes = [];

module.exports = (app, opts) => {
  options = opts;

  mapFolder(app, opts.directory, "");

  if (options.log === "all") {
    const biggestPath = mappedRoutes.reduce(
      (acc, it) => (it.path.length > acc ? it.path.length : acc),
      0
    );

    console.log(`${"".padEnd(15 + biggestPath, "-")}`);
    for (const route of mappedRoutes.sort((a, b) =>
      a.path.localeCompare(b.path)
    )) {
      console.log(
        `| ${route.verb.toUpperCase().padEnd(8)} | ${route.path.padEnd(
          biggestPath
        )} |`
      );
    }
    console.log(`${"".padEnd(15 + biggestPath, "-")}`);
  }

  console.log(`${mappedRoutes.length} routes mapped`);
};

let mapFolder = (app, currentPath, prefix) => {
  try {
    let currentResourceName = currentPath.split(/\W+/gi).pop();
    const isModule = path.parse(currentPath).name.startsWith("$");

    let actions = [];
    let folders = [];

    fs.readdirSync(currentPath)
      .map((n) => path.join(currentPath, n))
      .forEach((it) => {
        if (path.extname(it) === ".js" && !path.basename(it).startsWith("_"))
          actions.push(it);
        if (fs.lstatSync(it).isDirectory()) folders.push(it);
      });

    let routesToMap = [];

    for (const action of actions) {
      let {
        verb,
        route,
        handler,
        deep = true,
        member = true,
        delayed = false,
        anonymous,
        middlewares,
        ...pipesConfig
      } = require(action)(app);

      if (!middlewares) middlewares = [];

      for (let pipe in options.pipes || {}) {
        let pipeConfig = pipesConfig[pipe];

        if (pipeConfig) {
          middlewares.unshift(options.pipes[pipe](pipeConfig));
        }
      }

      if (options.middlewares) middlewares.unshift(...options.middlewares);

      if (!(anonymous || false) && options.authentication)
        middlewares.unshift(options.authentication);

      let fullRoute = `/${currentResourceName}${route}`;

      if (deep) fullRoute = `${prefix}${route}`;

      if (!member && !isModule) {
        const prefixes = prefix.split("/");
        const currentResourceIndex = prefixes.indexOf(currentResourceName);
        prefixes.splice(currentResourceIndex - 1, 1);
        const prefixWithoutMember = prefixes.join("/");

        fullRoute = `${prefixWithoutMember}${route}`;
      }

      routesToMap.push({
        verb: verb || "get",
        route: fullRoute,
        middlewares: [...middlewares],
        handler: async (req, res) => {
          try {
            if (!delayed) {
              return await handler(req, res);
            } else {
              if (options.environment === "production") {
                await app.models.ResourceDelayeds.create({
                  query: req.query,
                  params: req.params,
                  body: req.body,
                  user: req.user,
                  resource: action,
                });

                return res.json({ ok: true });
              } else {
                handler(
                  {
                    query: req.query,
                    params: req.params,
                    body: req.body,
                    user: req.user,
                  },
                  {
                    json: () => {},
                    send: () => {},
                  }
                ).then();

                return res.json({ ok: true });
              }
            }
          } catch (err) {
            // Fallback de TODAS as rotas. Não devolve err.message ao cliente:
            // vazava nome de tabela/coluna/constraint do Postgres e detalhes
            // internos (auditoria 30/08/2026). O detalhe fica no log do servidor.
            console.error(`[${req.method} ${req.originalUrl}] erro nao tratado:`, err);
            return res.status(500).send({ message: 'Erro interno ao processar a solicitação.' });
          }
        },
      });

      mappedRoutes.push({ verb, path: fullRoute });
    }

    let sizesCache = {};
    routesToMap
      .sort((a, b) => {
        let aSize = sizesCache[a.route];
        let bSize = sizesCache[b.route];

        if (!aSize) aSize = sizesCache[a.route] = a.route.split(":").length;
        if (!bSize) bSize = sizesCache[b.route] = b.route.split(":").length;

        return aSize - bSize;
      })
      .forEach((route) => {

        app[route.verb](route.route, route.middlewares, route.handler);
      });

    folders.forEach((folder) => {
      let pathName = folder.split(/\W+/gi).pop();

      let newPrefix =
        prefix === "" || isModule
          ? `${prefix}/${pathName}`
          : `${prefix}/:${pluralize.singular(currentResourceName)}/${pathName}`;

      mapFolder(app, folder, newPrefix);
    });
  } catch (err) {
    console.log("Impossible map routes at " + currentPath, true);
    console.log(err, true);
  }
};
