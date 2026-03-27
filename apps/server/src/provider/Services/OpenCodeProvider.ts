import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface OpenCodeProviderShape extends ServerProviderShape {}

export class OpenCodeProvider extends ServiceMap.Service<OpenCodeProvider, OpenCodeProviderShape>()(
  "t3/provider/Services/OpenCodeProvider",
) {}
