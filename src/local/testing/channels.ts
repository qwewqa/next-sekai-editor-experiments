import type { Channel } from '../channel'
import type { Actor, Scheduler } from '../scheduler'

/** BroadcastChannels between actors: each message is a task of every other open channel's actor. */
export class FakeChannels {
    private readonly open = new Map<string, Set<{ actor: Actor; channel: Channel }>>()
    /** Every message posted, for assertions. */
    readonly posted: { name: string; from: string; message: unknown }[] = []

    constructor(private readonly scheduler: Scheduler) {}

    channel(actor: Actor, name: string): Channel {
        let members = this.open.get(name)
        if (!members) this.open.set(name, (members = new Set()))
        const lane = this.scheduler.lane()
        const member = {
            actor,
            channel: {
                post: (message: unknown) => {
                    this.posted.push({ name, from: actor.name, message })
                    for (const other of members)
                        if (other !== member)
                            this.scheduler.post(other.actor, lane, () => {
                                if (members.has(other)) other.channel.onmessage?.(message)
                            })
                },
                onmessage: undefined,
                close: () => {
                    members.delete(member)
                },
            } as Channel,
        }
        members.add(member)
        this.scheduler.onKill(actor, () => {
            members.delete(member)
        })
        return member.channel
    }
}
