import type { Cache } from '@yarnpkg/core';
import {
  Hooks,
  Plugin,
  structUtils,
  Resolver,
  ResolveOptions,
  MinimalResolveOptions,
  Locator,
  SettingsType,
  Package,
  Descriptor,
  FetchOptions,
  Fetcher,
  miscUtils,
  DescriptorHash,
} from '@yarnpkg/core';
import { PortablePath, ppath, xfs, JailFS } from '@yarnpkg/fslib';
import { parseResolution, Resolution } from '@yarnpkg/parsers';

const PROTOCOL = `ignoreDeps:`;

const VERSION = '1'

type Mode = 'depsOf' | 'self';

function getMode(range: string): Mode {
  const { selector } = structUtils.parseRange(range);
  return selector === 'self' ? 'self' : 'depsOf';
}

function getOriginalDescriptor(desc: Descriptor) {
  const { source } = structUtils.parseRange(desc.range);
  return structUtils.parseDescriptor(source);
}

function addProtocolToDescriptor(desc: Descriptor, mode: Mode = 'depsOf') {
  return structUtils.makeDescriptor(
    desc,
    structUtils.makeRange({
      protocol: PROTOCOL,
      source: structUtils.stringifyDescriptor(desc),
      selector: mode,
      params: { version: VERSION },
    }),
  );
}

function getOriginalLocator(loc: Locator) {
  const { source } = structUtils.parseRange(loc.reference);
  return structUtils.parseLocator(source);
}

function addProtocolToLocator(loc: Locator, mode: Mode = 'depsOf') {
  return structUtils.makeLocator(
    loc,
    structUtils.makeRange({
      protocol: PROTOCOL,
      source: structUtils.stringifyLocator(loc),
      selector: mode,
      params: { version: VERSION },
    }),
  );
}

class IgnoreDepsResolver implements Resolver {
  supportsDescriptor(descriptor: Descriptor, opts: MinimalResolveOptions) {
    if (!descriptor.range.startsWith(PROTOCOL)) return false;
    return true;
  }

  supportsLocator(locator: Locator, opts: MinimalResolveOptions) {
    if (!locator.reference.startsWith(PROTOCOL)) return false;
    return true;
  }

  shouldPersistResolution(locator: Locator, opts: MinimalResolveOptions) {
    return opts.resolver.shouldPersistResolution(
      getOriginalLocator(locator),
      opts,
    );
  }

  bindDescriptor(
    _descriptor: Descriptor,
    fromLocator: Locator,
    opts: MinimalResolveOptions,
  ) {
    const mode = getMode(_descriptor.range);
    const descriptor = getOriginalDescriptor(_descriptor);
    return addProtocolToDescriptor(
      opts.resolver.bindDescriptor(descriptor, fromLocator, opts),
      mode,
    );
  }

  getResolutionDependencies(
    //todo check docs!!!
    _descriptor: Descriptor,
    opts: MinimalResolveOptions,
  ) {
    const descriptor = getOriginalDescriptor(_descriptor);
    return opts.resolver.getResolutionDependencies(descriptor, opts);
  }

  async getCandidates(
    _descriptor: Descriptor,
    dependencies: Record<string, Package>,
    opts: ResolveOptions,
  ) {
    const mode = getMode(_descriptor.range);
    const descriptor = getOriginalDescriptor(_descriptor);
    return (
      await opts.resolver.getCandidates(descriptor, dependencies, opts)
    ).map((loc) => addProtocolToLocator(loc, mode));
  }

  async getSatisfying(
    _descriptor: Descriptor,
    dependencies: Record<string, Package>,
    locators: Array<Locator>,
    opts: ResolveOptions,
  ) {
    const descriptor = getOriginalDescriptor(_descriptor);
    return opts.resolver.getSatisfying(
      descriptor,
      dependencies,
      locators,
      opts,
    );
  }

  async resolve(_locator: Locator, opts: ResolveOptions): Promise<Package> {
    const locator = getOriginalLocator(_locator);
    const sourcePkg = await opts.resolver.resolve(locator, opts);
    return {
      ...sourcePkg,
      locatorHash: _locator.locatorHash,
      reference: _locator.reference,
      peerDependencies: new Map(),
      dependencies: new Map(),
    };
  }
}

class IgnoreDepsFetcher implements Fetcher {
  supports(locator: Locator) {
    if (locator.reference.startsWith(PROTOCOL)) return true;

    return false;
  }

  getLocalPath(locator: Locator, opts: FetchOptions) {
    if (getMode(locator.reference) === 'self') return null;
    return opts.fetcher.getLocalPath(getOriginalLocator(locator), opts);
  }

  async fetch(locator: Locator, opts: FetchOptions) {
    if (getMode(locator.reference) === 'self') {
      const pkg = opts.project.storedPackages.get(locator.locatorHash);
      if (!pkg) {
        throw new Error(
          `Package ${structUtils.stringifyIdent(locator)} not found in the project (yarn-plugin-ignore-deps)`,
        );
      }
      const tempDir = await xfs.mktempPromise();
      await xfs.writeJsonPromise(
        ppath.join(tempDir, 'package.json' as PortablePath),
        {
          name: structUtils.stringifyIdent(pkg),
          version: pkg.version,
          __info: 'mocked by yarn-plugin-ignore-deps',
        },
      );
      return {
        packageFs: new JailFS(tempDir),
        prefixPath: PortablePath.dot,
      };
    }
    const outerLocator = locator;
    const innerLocator = getOriginalLocator(locator);
    const outerChecksum =
      opts.checksums.get(outerLocator.locatorHash) ?? null;
    const report = new Proxy(opts.report, {
      get(target, prop, receiver) {
        if (prop === 'reportCacheHit') {
          return () => target.reportCacheHit(outerLocator);
        }
        if (prop === 'reportCacheMiss') {
          return (_loc: Locator, message?: string) =>
            target.reportCacheMiss(outerLocator, message);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const cache = new Proxy(opts.cache, {
      get(target, prop, receiver) {
        if (prop === 'fetchPackageFromCache') {
          const fn = Reflect.get(target, prop, receiver) as Cache['fetchPackageFromCache'];
          return (
            loc: Locator,
            checksum: string | null,
            options: Parameters<Cache['fetchPackageFromCache']>[2],
          ) =>
            loc.locatorHash === innerLocator.locatorHash
              ? fn.call(target, outerLocator, outerChecksum, options)
              : fn.call(target, loc, checksum, options);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return opts.fetcher.fetch(innerLocator, { ...opts, cache, report });
  }
}

function isMatched(
  pattern: Resolution,
  dependency: Descriptor,
  locator: Locator,
) {
  if (pattern.from) {
    if (pattern.from.fullName !== '*') {
      if (pattern.from.fullName !== structUtils.stringifyIdent(locator)) {
        return false;
      }
    }
  }
  if (pattern.descriptor.fullName === '*') {
    return true;
  }
  return pattern.descriptor.fullName === structUtils.stringifyIdent(dependency);
}
const memo = (() => {
  const map = new WeakMap();
  return <K extends object, T extends object>(k: K, fn: (k: K) => T): T => {
    if (!map.has(k)) {
      map.set(k, fn(k));
    }
    return map.get(k);
  };
})();

const hooks: Hooks = {
  async reduceDependency(
    dependency,
    project,
    locator, //parent
    initialDependency,
    extra,
  ) {
    const ignoreDeps = memo(
      project.configuration.get('ignoreDependencies').get('deps'),
      (deps) => deps.map(parseResolution),
    );

    for (const pattern of ignoreDeps) {
      if (isMatched(pattern, dependency, locator)) {
        return addProtocolToDescriptor(dependency, 'self');
      }
    }

    const ignoreDepsOf = memo(
      project.configuration.get('ignoreDependencies').get('depsOf'),
      (deps) => deps.map(parseResolution),
    );

    for (const pattern of ignoreDepsOf) {
      if (isMatched(pattern, dependency, locator)) {
        return addProtocolToDescriptor(dependency, 'depsOf');
      }
    }
    return dependency;
  },
};

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    ignoreDependencies: miscUtils.ToMapValue<{
      depsOf: Array<string>;
      deps: Array<string>;
    }>;
  }
}

const plugin: Plugin = {
  configuration: {
    ignoreDependencies: {
      type: SettingsType.SHAPE,
      description: 'Ignore packages',
      properties: {
        depsOf: {
          description: ``,
          default: [],
          isArray: true,
          type: SettingsType.STRING,
        },
        deps: {
          description: ``,
          default: [],
          isArray: true,
          type: SettingsType.STRING,
        },
      },
    },
  },
  hooks,
  resolvers: [IgnoreDepsResolver],
  fetchers: [IgnoreDepsFetcher],
  commands: [],
};

export default plugin;
