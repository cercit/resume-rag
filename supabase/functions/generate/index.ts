// POST { resume_text, jd_text } -> { session_id, resume, tweaks_left, notes }
import { serve } from "../_shared/handler.ts";
import { generate } from "../_shared/pipeline.ts";

serve((body, deps) => generate(body, deps), "Something failed. Please try again.");
