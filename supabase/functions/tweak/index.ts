// POST { session_id, instruction } -> { resume, tweaks_left, notes }
import { serve } from "../_shared/handler.ts";
import { tweak } from "../_shared/pipeline.ts";

serve((body, deps) => tweak(body, deps), "Something failed. You were not charged a tweak.");
