# Tau

Web frontend and mirror for the pi agent. Lets a user view and drive agent sessions from a browser.

## Language

**Live session**:
The session a pi process is currently writing. In the Tau frontend it is interactive: the composer accepts input.
_Avoid_: active session, current session

**Historical session**:
A saved session the user is viewing read-only in the Tau frontend.
_Avoid_: old session, past session, archived session

**Resume**:
Make a historical session the live session of the mirrored pi process. The agent's working directory follows the directory recorded in the session.
_Avoid_: reopen, restore, continue

**Instance registry**:
The per-user record of running pi instances that carry Tau. Each entry holds the instance's port, URL prefix, pid, current session, and working directory. It is container-local and never mounted.
_Avoid_: instance list, process table

**Instance identity**:
The pair (URL prefix, pid) by which a Tau client tells its own serving instance apart from any other. The prefix is the instance's base path (`TAU_BASE_PATH`, e.g. `/agent/43221/`; empty at root): globally unique across containers by the dashboard port contract, but one per container — identical for every process in it. The pid is unique within one container's PID namespace, and repeats across containers. Ports never carry identity: the same instance wears a container port, a host-mapped port, and a dashboard port depending on the viewing context.
_Avoid_: instance port, instance address

**Live elsewhere**:
The condition where a viewed session file is the live session of an instance other than the one serving the page. The sidebar live marker and the metadata panel note key off it.
_Avoid_: session conflict, duplicate session
