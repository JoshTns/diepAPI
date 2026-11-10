import { EventEmitter } from '../core';
import { assert } from '../utils/assert';

export type WasmInstanceEvents = 'instantiated';

/**
 * Events:
 * - instantiated: Emitted when the wasm instance is instantiated
 */
class WasmInstance extends EventEmitter<WasmInstanceEvents> {
  #instance: WebAssembly.Instance | null = null;
  #module: WebAssembly.Module | null = null;
  #importDescriptors: WebAssembly.ModuleImportDescriptor[] | null = null;
  #exportDescriptors: WebAssembly.ModuleExportDescriptor[] | null = null;
  #imports: WebAssembly.Imports | null = null;
  #exports: WebAssembly.Exports | null = null;
  #memory: WebAssembly.Memory | null = null;
  #bytes: Uint8Array | null = null;

  /** The game's wasm module bytes, as fetched. Used by the signature resolver. */
  get bytes(): Uint8Array | null {
    return this.#bytes;
  }

  get instance(): WebAssembly.Instance | null {
    return this.#instance;
  }

  get module(): WebAssembly.Module | null {
    return this.#module;
  }

  get importDescriptors(): WebAssembly.ModuleImportDescriptor[] | null {
    return this.#importDescriptors;
  }
  get exportDescriptors(): WebAssembly.ModuleExportDescriptor[] | null {
    return this.#exportDescriptors;
  }

  get imports(): WebAssembly.Imports | null {
    return this.#imports;
  }

  get exports(): WebAssembly.Exports | null {
    return this.#exports;
  }

  get memory(): WebAssembly.Memory | null {
    return this.#memory;
  }

  constructor() {
    super();
    WebAssembly.instantiateStreaming = new Proxy(WebAssembly.instantiateStreaming, {
      apply: async (
        target,
        thisArg,
        args: [Response | PromiseLike<Response>, WebAssembly.Imports | undefined],
      ) => {
        const [source, importObject] = args;
        assert(source instanceof Promise, 'diepAPI: Source must be a Response');
        assert(importObject != null, 'diepAPI: importObject must be a WebAssembly.Imports');

        // Keep a copy of the module bytes for the signature resolver.
        const response: Response = await source;
        const bytesPromise = response
          .clone()
          .arrayBuffer()
          .then((buf: ArrayBuffer) => new Uint8Array(buf));

        const result = await Reflect.apply(target, thisArg, [response, importObject]);
        this.#bytes = await bytesPromise;

        this.#capture(result.module, result.instance, importObject);
        return result;
      },
    });

    // The game falls back to WebAssembly.instantiate(bytes) if streaming compilation fails.
    WebAssembly.instantiate = new Proxy(WebAssembly.instantiate, {
      apply: async (target, thisArg, args: [BufferSource | WebAssembly.Module, WebAssembly.Imports?]) => {
        const [source, importObject] = args;
        const isGameLoad =
          this.#instance === null && !(source instanceof WebAssembly.Module) && importObject != null;
        // copy before instantiating, in case the caller reuses the buffer
        const bytes = isGameLoad
          ? ArrayBuffer.isView(source)
            ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
            : new Uint8Array(source as ArrayBuffer).slice()
          : null;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const result = await Reflect.apply(target, thisArg, args);
        if (isGameLoad && bytes !== null && importObject != null) {
          this.#bytes = bytes;
          const r = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          this.#capture(r.module, r.instance, importObject);
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return result;
      },
    });
  }

  #capture(
    module: WebAssembly.Module,
    instance: WebAssembly.Instance,
    importObject: WebAssembly.Imports,
  ): void {
    this.#instance = instance;
    this.#module = module;

    this.#importDescriptors = WebAssembly.Module.imports(module);
    this.#exportDescriptors = WebAssembly.Module.exports(module);

    this.#imports = importObject;
    this.#exports = instance.exports;

    const memoryDescriptor = this.#exportDescriptors.find((desc) => desc.kind === 'memory');
    assert(memoryDescriptor != null, 'diepAPI: No memory export found in WASM module');

    this.#memory = this.#exports[memoryDescriptor.name] as WebAssembly.Memory;
    assert(this.#memory instanceof WebAssembly.Memory, 'diepAPI: Exported memory is invalid');

    super.emit('instantiated');
    console.log('diepAPI: WASM instance instantiated');
  }
}

export const wasmInstance = new WasmInstance();
