import { ProviderRegistry } from "@atlas/provider-sdk";
import { razorpayModule } from "@atlas/providers-razorpay/module";
import { whatsappModule } from "@atlas/providers-whatsapp/module";

const builtinProviders = [razorpayModule, whatsappModule];

export function createProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  return ProviderRegistry.fromEnv(builtinProviders, env);
}

export { builtinProviders };
