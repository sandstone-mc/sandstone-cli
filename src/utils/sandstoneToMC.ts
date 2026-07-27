/**
 * Sandstone minor version → Minecraft major.minor mapping.
 *
 * Each sandstone 1.x.y corresponds exactly to one Minecraft version.
 * MC has 4 bases per year (26.1-26.4, 27.1-27.4, ...). Sandstone major 2
 * is out of scope and will be revisited when it ships.
 *
 * Kept in sync with /var/home/mulverine/Workspaces/sandstone-work/scripts/sandstoneToMC.ts
 * (deterministic — no shared package needed).
 */

export interface MCVersion {
	mcMajor: number
	mcMinor: number
}

export function sandstoneMinorToMC(minor: number): MCVersion {
	return {
		mcMajor: 26 + Math.floor(minor / 4),
		mcMinor: (minor % 4) + 1,
	}
}

export function sandstoneMinorToMCString(minor: number): string {
	const { mcMajor, mcMinor } = sandstoneMinorToMC(minor)
	return `${mcMajor}.${mcMinor}`
}
