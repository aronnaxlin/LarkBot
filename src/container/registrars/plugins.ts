import { plugins } from '../../../plugins/src/index';
import { createPluginHost } from '../../plugins/host';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerPlugins = ({ get, register }: Registrar): void => {
  register(TOKENS.PLUGIN_HOST, () =>
    createPluginHost({
      config: get(TOKENS.CONFIG),
      eventSink: get(TOKENS.EVENT_SINK),
      logger: get(TOKENS.LOGGER),
      plugins,
    }));
};
