import {
  Match,
  Route,
  RouteHooks,
  QContext,
  NavigateOptions,
  ResolveOptions,
  GenerateOptions,
  Handler,
  RouterOptions,
  BeforeHook,
  AfterHook,
  LeaveHook,
  AlreadyHook
} from "../index";
//import NavigoRouter from "../index";
import {
  pushStateAvailable,
  matchRoute,
  parseQuery,
  extractGETParameters,
  isFunction,
  isString,
  clean,
  parseNavigateOptions,
  windowAvailable,
  getCurrentEnvURL,
  accumulateHooks,
  extractHashFromURL,
} from "./utils";
import Q from "./Q";
import setLocationPath from "./middlewares/setLocationPath";
import matchPathToRegisteredRoutes from "./middlewares/matchPathToRegisteredRoutes";
import checkForDeprecationMethods from "./middlewares/checkForDeprecationMethods";
import checkForForceOp from "./middlewares/checkForForceOp";
import updateBrowserURL from "./middlewares/updateBrowserURL";
import processMatches from "./middlewares/processMatches";
import waitingList from "./middlewares/waitingList";

import { notFoundLifeCycle } from "./lifecycles";

const DEFAULT_LINK_SELECTOR = "[data-navigo]";

class Navigo {
  constructor(appRoute?: string, options?: RouterOptions) {
    this.DEFAULT_RESOLVE_OPTIONS = options || {
      strategy: "ONE",
      hash: false,
      noMatchWarning: false,
      linksSelector: DEFAULT_LINK_SELECTOR,
    };

    if (!appRoute) {
      console.warn(
        'Navigo requires a root path in its constructor. If not provided will use "/" as default.'
      );
    } else {
      this.root = clean(appRoute);
    }
  }

  //----------------
  // Properties
  //----------------

  __dirty = false;
  __freezeListening = false;
  __popstateListener: any = null;
  __waiting: any = [];

  _notFoundRoute: Route = null;

  DEFAULT_RESOLVE_OPTIONS: RouterOptions;

  root = "/";

  current: Match[] = null;
  routes: Route[] = [];
  destroyed = false;
  genericHooks: RouteHooks;

  isPushStateAvailable = pushStateAvailable();
  isWindowAvailable = windowAvailable();

  //------------------------
  // Public Methods
  //------------------------

  composePathWithRoot(path: string) {
    return clean(`${this.root}/${clean(path)}`);
  }

  createRoute(
    path: string | RegExp,
    handler: Handler,
    hooks: RouteHooks[],
    name?: string
  ): Route {
    path = isString(path) ? this.composePathWithRoot(path as string) : path;
    return {
      name: name || clean(String(path)),
      path,
      handler,
      hooks: accumulateHooks(hooks),
    };
  }

  on(
    path: string | Function | Object | RegExp,
    handler?: Handler,
    hooks?: RouteHooks
  ) {
    if (typeof path === "object" && !(path instanceof RegExp)) {
      Object.keys(path).forEach((p) => {
        if (typeof path[p] === "function") {
          this.on(p, path[p]);
        } else {
          const { uses: handler, as: name, hooks } = path[p];
          this.routes.push(this.createRoute(p, handler, [this.genericHooks, hooks], name));
        }
      });
      return this;
    } else if (typeof path === "function") {
      hooks = handler as RouteHooks;
      handler = path as Handler;
      path = this.root;
    }
    this.routes.push(
      this.createRoute(path as string | RegExp, handler, [this.genericHooks, hooks])
    );
    return this;
  }

  resolve(to?: string, options?: ResolveOptions): false | Match[] {
    if (this.__dirty) {
      this.__waiting.push(() => this.resolve(to, options));
      return;
    } else {
      this.__dirty = true;
    }
    to = to ? `${clean(this.root)}/${clean(to)}` : undefined;
    const context: QContext = {
      instance: this,
      to,
      currentLocationPath: to,
      navigateOptions: {},
      resolveOptions: { ...this.DEFAULT_RESOLVE_OPTIONS, ...options },
    };
    Q(
      [
        setLocationPath,
        matchPathToRegisteredRoutes,
        Q.if(
          ({ matches }: QContext) => matches && matches.length > 0,
          processMatches,
          notFoundLifeCycle
        ),
      ],
      context,
      waitingList
    );

    return context.matches ? context.matches : false;
  }

  navigate(to: string, navigateOptions?: NavigateOptions): void {
    if (this.__dirty) {
      this.__waiting.push(() => this.navigate(to, navigateOptions));
      return;
    } else {
      this.__dirty = true;
    }
    to = `${clean(this.root)}/${clean(to)}`;
    const context: QContext = {
      instance: this,
      to,
      navigateOptions: navigateOptions || {},
      resolveOptions:
        navigateOptions && navigateOptions.resolveOptions
          ? navigateOptions.resolveOptions
          : this.DEFAULT_RESOLVE_OPTIONS,
      currentLocationPath: this._checkForAHash(to),
    };
    Q(
      [
        checkForDeprecationMethods,
        checkForForceOp,
        matchPathToRegisteredRoutes,
        Q.if(
          ({ matches }: QContext) => matches && matches.length > 0,
          processMatches,
          notFoundLifeCycle
        ),
        updateBrowserURL,
        waitingList,
      ],
      context,
      waitingList
    );
  }

  navigateByName(
    name: string,
    data?: Object,
    options?: NavigateOptions
  ): boolean {
    const url = this.generate(name, data);
    if (url !== null) {
      this.navigate(url.replace(new RegExp(`^\/?${this.root}`), ""), options);
      return true;
    }
    return false;
  }

  off(what: string | RegExp | Function) {
    this.routes = this.routes.filter((r) => {
      if (isString(what)) {
        return clean(r.path as string) !== clean(what as string);
      } else if (isFunction(what)) {
        return what !== r.handler;
      }
      return String(r.path) !== String(what);
    });
    return this;
  }

  listen() {
    if (this.isPushStateAvailable) {
      this.__popstateListener = () => {
        if (!this.__freezeListening) {
          this.resolve();
        }
      };
      window.addEventListener("popstate", this.__popstateListener);
    }
  }

  destroy() {
    this.routes = [];
    if (this.isPushStateAvailable) {
      window.removeEventListener("popstate", this.__popstateListener);
    }
    this.destroyed = true;
  }

  notFound(handler: Handler, hooks?: RouteHooks) {
    this._notFoundRoute = this.createRoute(
      "*",
      handler,
      [this.genericHooks, hooks],
      "__NOT_FOUND__"
    );
    return this;
  }

  updatePageLinks() {
    if (!this.isWindowAvailable) return;
    this.findLinks().forEach((link: any) => {
      if (
        "false" === link.getAttribute("data-navigo") ||
        "_blank" === link.getAttribute("target")
      ) {
        if (link.hasListenerAttached) {
          link.removeEventListener("click", link.navigoHandler);
        }
        return;
      }
      if (!link.hasListenerAttached) {
        link.hasListenerAttached = true;
        link.navigoHandler = (e: MouseEvent) => {
          if (
            (e.ctrlKey || e.metaKey) &&
            (e.target as HTMLElement).tagName.toLowerCase() === "a"
          ) {
            return false;
          }
          let location = link.getAttribute("href");
          if (typeof location === "undefined" || location === null) {
            return false;
          }
          // handling absolute paths
          if (location.match(/^(http|https)/) && typeof URL !== "undefined") {
            try {
              const u = new URL(location);
              location = u.pathname + u.search;
            } catch (err) {}
          }
          const options = parseNavigateOptions(
            link.getAttribute("data-navigo-options")
          );

          if (!this.destroyed) {
            e.preventDefault();
            e.stopPropagation();
            this.navigate(clean(location), options);
          }
        };
        link.addEventListener("click", link.navigoHandler);
      }
    });
    return this;
  }

  findLinks() {
    if (this.isWindowAvailable) {
      return [].slice.call(
        document.querySelectorAll(
          this.DEFAULT_RESOLVE_OPTIONS.linksSelector || DEFAULT_LINK_SELECTOR
        )
      );
    }
    return [];
  }

  link(path: string) {
    return `/${this.root}/${clean(path)}`;
  }

  setGenericHooks(hooks: RouteHooks) {
    this.genericHooks = hooks;
    return this;
  }

  hooks(hooks: RouteHooks) {
    this.genericHooks = hooks;
    return this;
  }

  lastResolved(): Match[] | null {
    return this.current;
  }

  generate(
    name: string,
    data?: Object,
    options?: GenerateOptions
  ): string {
    const route = this.routes.find((r) => r.name === name);
    let result = null;
    if (route) {
      result = route.path as string;
      if (data) {
        for (let key in data) {
          result = result.replace(":" + key, data[key]);
        }
      }
      result = !result.match(/^\//) ? `/${result}` : result;
    }
    if (result && options && !options.includeRoot) {
      result = result.replace(new RegExp(`^/${this.root}`), "");
    }
    return result;
  }

  getLinkPath(link: HTMLElement) {
    return link.getAttribute("href");
  }

  pathToMatchObject(path: string): Match {
    const [url, queryString] = extractGETParameters(clean(path));
    const params: any = queryString === "" ? null : parseQuery(queryString);
    const hashString = extractHashFromURL(path);
    const route = this.createRoute(url, () => {}, [this.genericHooks], url);
    return {
      url,
      queryString,
      hashString,
      route,
      data: null,
      params: params,
    };
  }

  _pathToMatchObject(path: string): Match {
    const [url, queryString] = extractGETParameters(clean(path));
    const params: any = queryString === "" ? null : parseQuery(queryString);
    const hashString = extractHashFromURL(path);
    const route = this.createRoute(url, () => {}, [this.genericHooks], url);
    return {
      url,
      queryString,
      hashString,
      route,
      data: null,
      params: params,
    };
  }

  getCurrentLocation(): Match {
    return this.pathToMatchObject(
      clean(getCurrentEnvURL(this.root)).replace(new RegExp(`^${this.root}`), "")
    );
  }

  directMatchWithRegisteredRoutes(path: string): false | Match[] {
    const context: QContext = {
      instance: this,
      currentLocationPath: path,
      to: path,
      navigateOptions: {},
      resolveOptions: this.DEFAULT_RESOLVE_OPTIONS,
    };
    matchPathToRegisteredRoutes(context, () => {});
    return context.matches ? context.matches : false;
  }

  match(path: string): false | Match[] {
    const context: QContext = {
      instance: this,
      currentLocationPath: path,
      to: path,
      navigateOptions: {},
      resolveOptions: this.DEFAULT_RESOLVE_OPTIONS,
    };
    matchPathToRegisteredRoutes(context, () => {});
    return context.matches ? context.matches : false;
  }

  directMatchWithLocation(
    path: string | RegExp,
    currentLocation?: string,
    annotatePathWithRoot?: boolean
  ): false | Match {
    if (
      typeof currentLocation !== "undefined" &&
      (typeof annotatePathWithRoot === "undefined" || annotatePathWithRoot)
    ) {
      currentLocation = this.composePathWithRoot(currentLocation);
    }
    const context: QContext = {
      instance: this,
      to: currentLocation,
      currentLocationPath: currentLocation,
    };
    setLocationPath(context, () => {});
    if (typeof path === "string") {
      path =
        typeof annotatePathWithRoot === "undefined" || annotatePathWithRoot
          ? this.composePathWithRoot(path)
          : path;
    }
    const match = matchRoute(context, {
      name: String(path),
      path,
      handler: () => {},
      hooks: {},
    });
    return match ? match : false;
  }

  matchLocation(
    path: string | RegExp,
    currentLocation?: string,
    annotatePathWithRoot?: boolean
  ): false | Match {
    if (
      typeof currentLocation !== "undefined" &&
      (typeof annotatePathWithRoot === "undefined" || annotatePathWithRoot)
    ) {
      currentLocation = this.composePathWithRoot(currentLocation);
    }
    const context: QContext = {
      instance: this,
      to: currentLocation,
      currentLocationPath: currentLocation,
    };
    setLocationPath(context, () => {});
    if (typeof path === "string") {
      path =
        typeof annotatePathWithRoot === "undefined" || annotatePathWithRoot
          ? this.composePathWithRoot(path)
          : path;
    }
    const match = matchRoute(context, {
      name: String(path),
      path,
      handler: () => {},
      hooks: {},
    });
    return match ? match : false;
  }

  addBeforeHook(
    route: Route | string,
    func: BeforeHook
  ): Function {
    const type = "before";
    if (typeof route === "string") {
      route = this.getRoute(route);
    }
    if (route) {
      if (!route.hooks[type]) route.hooks[type] = [];
      route.hooks[type].push(func);
      return () => {
        (route as Route).hooks[type] = (route as Route).hooks[type].filter(
          (f) => f !== func
        );
      };
    } else {
      console.warn(`Route doesn't exists: ${route}`);
    }
    return () => {};
  }

  addAfterHook(
    route: Route | string,
    func: AfterHook
  ): Function {
    const type = "after";
    if (typeof route === "string") {
      route = this.getRoute(route);
    }
    if (route) {
      if (!route.hooks[type]) route.hooks[type] = [];
      route.hooks[type].push(func);
      return () => {
        (route as Route).hooks[type] = (route as Route).hooks[type].filter(
          (f) => f !== func
        );
      };
    } else {
      console.warn(`Route doesn't exists: ${route}`);
    }
    return () => {};
  }

  addAlreadyHook(
    route: Route | string,
    func: AlreadyHook
  ): Function {
    const type = "already";
    if (typeof route === "string") {
      route = this.getRoute(route);
    }
    if (route) {
      if (!route.hooks[type]) route.hooks[type] = [];
      route.hooks[type].push(func);
      return () => {
        (route as Route).hooks[type] = (route as Route).hooks[type].filter(
          (f) => f !== func
        );
      };
    } else {
      console.warn(`Route doesn't exists: ${route}`);
    }
    return () => {};
  }

  addLeaveHook(
    route: Route | string,
    func: LeaveHook
  ): Function {
    const type = "leave";
    if (typeof route === "string") {
      route = this.getRoute(route);
    }
    if (route) {
      if (!route.hooks[type]) route.hooks[type] = [];
      route.hooks[type].push(func);
      return () => {
        (route as Route).hooks[type] = (route as Route).hooks[type].filter(
          (f) => f !== func
        );
      };
    } else {
      console.warn(`Route doesn't exists: ${route}`);
    }
    return () => {};
  }

  getRoute(nameOrHandler: string | Function): Route | undefined {
    if (typeof nameOrHandler === "string") {
      return this.routes.find((r) => r.name === this.composePathWithRoot(nameOrHandler));
    }
    return this.routes.find((r) => r.handler === nameOrHandler);
  }

  __markAsClean(context: QContext) {
    context.instance.__dirty = false;
    if (context.instance.__waiting.length > 0) {
      context.instance.__waiting.shift()();
    }
  }

  //--------------------------------
  // Private Methods
  //--------------------------------

  _checkForAHash = (url: string): string => {
    if (url.indexOf("#") >= 0) {
      if (this.DEFAULT_RESOLVE_OPTIONS.hash === true) {
        url = url.split("#")[1] || "/";
      } else {
        url = url.split("#")[0];
      }
    }
    return url;
  }

  _clean(s: string) {
    return s.replace(/\/+$/, "").replace(/^\/+/, "");
  }

  _setCurrent = (c: Match[]) => {
    this.current = c;
  }
}

export default Navigo;
