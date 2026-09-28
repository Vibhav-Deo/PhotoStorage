[SYSTEM INTERVENTION: STOP REPEATED TOOL CALLS]

You are stuck in a repetitive loop making the exact same tool call or failing to parse outputs. Stop. Do not attempt the same tool call again. 

Instead, perform the following recovery protocol immediately:
1. Examine the exact error or empty result you just received from the last tool execution.
2. Read the project directory/relevant file again using a DIFFERENT approach or a lower-level command (e.g., if a custom tool failed, use a standard terminal fallback like `cat`, `ls`, or `find` if safe to do so).
3. If you lack critical information, ask ME directly for clarification instead of guessing via automated tools.
4. Output a brief 1-sentence summary explaining why your last attempt failed, then propose an alternative action.

Acknowledge this reset and state your alternative next step.
