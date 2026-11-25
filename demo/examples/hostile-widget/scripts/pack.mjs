#!/usr/bin/env node
import { pack } from "@vibe/plugin-contracts/cli";

console.log(await pack(process.cwd()));
