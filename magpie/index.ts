import { startMagpieBenchService } from './magpie_service.ts';
import { createMagpieBenchPlugin } from './mini_bench_plugin.ts';

const lifecycle = createMagpieBenchPlugin(startMagpieBenchService);
process.once('exit', () => {
  void lifecycle.stop();
});

// Magpie invokes every exported function as a plugin, so expose only its plugin object.
export default lifecycle.plugin;
