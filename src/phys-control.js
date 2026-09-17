/* Who may do what in a physics room.
 *
 * The default is `open`: any connection may send any command. That is deliberate and it is what
 * makes a shared world feel shared — twenty phones are twenty hands, and none of them has to ask
 * the big screen for permission. The Marshmallow Challenge works precisely because the phone lays
 * the tape.
 *
 * Some games want the opposite. A quiz round where the audience watches a tower fall; a board the
 * host resets between rounds; a game where phones may shove things but only the host may add or
 * delete them. For those a world says:
 *
 *   control: 'open'                                  anyone, anything (the default)
 *   control: 'host'                                  phones watch; only the host changes the world
 *   control: { players: ['grab', 'drag', 'release'] } phones may carry things and nothing else
 *   control: { players: ['grab', 'drag', 'release', 'turn', 'joint'] }   ... and tape them together
 *
 * "Host" has to mean something for any of this to hold. A connection asking for ?role=host is not
 * evidence — anyone can type that. The room mints a key when it builds the world and hands it to
 * the connection that built it; a connection counts as a host only if it presents that key. So the
 * policy is enforced against something the room issued, not against a claim in a URL.
 */

/** Every command a connection can send. `world` and `control` are always host-only. */
export const COMMANDS = ['add', 'remove', 'impulse', 'torque', 'velocity', 'place', 'gravity', 'grab', 'drag', 'release', 'turn', 'joint', 'unjoint'];
export const HOST_ONLY = ['world', 'control'];

/** Commands that are only ever about what this connection is already holding. */
export const HAND_COMMANDS = ['grab', 'drag', 'release', 'turn'];

/**
 * A `control` value from a spec -> { players: string[] }, the commands a non-host may send.
 * Unknown command names are reported rather than silently dropped: a typo in a whitelist would
 * otherwise lock a game's phones out and look like a bug in the room.
 */
export function normaliseControl(control, errors = []) {
  if (control == null || control === 'open') return { players: [...COMMANDS] };
  if (control === 'host') return { players: [] };
  if (Array.isArray(control)) return normaliseControl({ players: control }, errors);
  if (typeof control === 'object' && Array.isArray(control.players)) {
    const players = [];
    for (const c of control.players) {
      if (COMMANDS.includes(c)) players.push(c);
      else if (HOST_ONLY.includes(c)) errors.push(`control: "${c}" is always the host's, it cannot be given to players`);
      else errors.push(`control: unknown command "${c}" (have: ${COMMANDS.join(', ')})`);
    }
    return { players: [...new Set(players)] };
  }
  errors.push(`control: expected 'open', 'host' or { players: [...] }`);
  return { players: [...COMMANDS] };
}

/** May this connection send this command? */
export function allowed(control, command, isHost) {
  if (HOST_ONLY.includes(command)) return !!isHost;
  if (!COMMANDS.includes(command)) return false;
  if (isHost) return true;
  return (control?.players || []).includes(command);
}

/** Why not — a sentence a game author can act on, rather than silence. */
export function refusal(control, command) {
  const open = control?.players || [];
  if (HOST_ONLY.includes(command)) return `"${command}" is the host's: this connection did not present the room's host key`;
  if (!COMMANDS.includes(command)) return `unknown command "${command}"`;
  return open.length
    ? `this world lets players send ${open.join(', ')} — "${command}" is the host's`
    : `this world is host-controlled: players may watch, but not send "${command}"`;
}

/** What a client should be told it may do, so it can grey a button out rather than guess. */
export function permissions(control, isHost) {
  return {
    host: !!isHost,
    may: isHost ? [...COMMANDS, ...HOST_ONLY] : [...(control?.players || [])],
    open: (control?.players || []).length === COMMANDS.length,
  };
}
