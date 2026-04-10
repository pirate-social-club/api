#!/usr/bin/env bun

import { main } from "./main.js"
import { handleFatal } from "./output.js"

void main(process.argv.slice(2)).catch(handleFatal)
