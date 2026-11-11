// perchlight-forms: a self-hosted form backend for static sites on
// Cloudflare Workers + D1 (+ R2 for file uploads).
// Your forms are defined in forms.json at the repo root; a push redeploys.
// There is no cron trigger: retries and clean-up run lazily (docs/adr/0001).
import forms from "../forms.json";
import { makeWorker } from "./app.js";

export default makeWorker(forms);
