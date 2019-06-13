import fs from 'fs'
import path from 'path'
import timestamp from 'time-stamp'
import cron, { ScheduledTask } from 'node-cron'
import { getScheduleString, logger, message, time } from '../../utils'
import { Hermes, Dialog, NluSlot, slotType } from 'hermes-javascript'
import { parseExpression } from 'cron-parser'
import { i18nFactory } from '../../factories'
import { ALARM_CRON_EXP, DIR_DB, SLOT_CONFIDENCE_THRESHOLD } from '../../constants'
import { EventEmitter } from 'events'

export type SerializedAlarm = {
    id: string
    name: string
    schedule: string
    date: string
    recurrence?: string
}

/**
 * Alarm
 * 
 * @exception {pastAlarmDatetime}
 * @exception {noTaskAlarmBeepFound} 
 */
export class Alarm extends EventEmitter {
    id: string = ''
    date: Date = new Date()
    recurrence: string | null = null
    name: string | null = null
    schedule: string = ''
    taskAlarm: ScheduledTask | null = null
    taskAlarmBeep: ScheduledTask | null = null
    delayed: boolean = false
    
    constructor(hermes: Hermes, date: Date, recurrence?: string, name?: string, id?: string) {
        super()

        this.id = id || timestamp('YYYYMMDD-HHmmss-ms')
        this.recurrence = recurrence || null
        this.name = name || null
        this.schedule = getScheduleString(date, this.recurrence)

        if (this.recurrence) {
            do {
                this.date = new Date(parseExpression(this.schedule).next().toString())
            } while (this.date < new Date())
        } else {
            this.date = date
        }

        this.makeAlive(hermes)
    }

    /**
     * Create and start cron task
     * 
     * @param hermes 
     */
    makeAlive(hermes: Hermes) {
        const dialogId: string = `snips-assistant:alarm:${ this.id }`
        console.log(dialogId)

        const onExpiration = () => {
            const i18n = i18nFactory.get()

            let tts: string = ''
            if (this.name) {
                tts += i18n('alarm.info.expired', {
                    name: this.name,
                    context: 'name'
                })
            } else {
                tts += i18n('alarm.info.expired')
            }

            hermes.dialog().sessionFlow(dialogId, (_, flow) => {
                flow.continue('snips-assistant:StopSilence', (_, flow) => {
                    this.reset()
                    flow.end()
                })
                flow.continue('snips-assistant:ElicitSnooze', (msg, flow) => {
                    const durationSlot: NluSlot<slotType.duration> | null = message.getSlotsByName(msg, 'duration', {
                        onlyMostConfident: true,
                        threshold: SLOT_CONFIDENCE_THRESHOLD
                    })

                    if (durationSlot) {
                        this.delayed = true
                        setTimeout(() => { this.delayed = false }, time.getDurationSlotValueInMs(durationSlot))
                    }

                    flow.end()
                })
            })

            if (!this.delayed) {
                hermes.dialog().publish('start_session', {
                    init: {
                        type: Dialog.enums.initType.action,
                        text: '[[sound:alarm.beep]] ' + tts,
                        intentFilter: [
                            'snips-assistant:StopSilence',
                            'snips-assistant:ElicitSnooze'
                        ],
                        canBeEnqueued: false,
                        sendIntentNotRecognized: true
                    },
                    customData: dialogId,
                    siteId: 'default'
                })
            }
        }

        this.taskAlarmBeep = cron.schedule(ALARM_CRON_EXP, onExpiration, { scheduled: false })
        this.taskAlarm = cron.schedule(this.schedule, () => {
            if (this.taskAlarmBeep) {
                this.taskAlarmBeep.start()
            } else {
                throw new Error('noTaskAlarmBeepFound')
            }
        })
    }

    /**
     * Elicit alarm info to string
     */
    toString() {
        return JSON.stringify({
            id: this.id,
            name: this.name,
            schedule: this.schedule,
            date: this.date.toJSON(),
            recurrence: this.recurrence
        })
    }

    /**
     * Save alarm info to fs
     */
    save() {
        fs.writeFile(path.resolve(__dirname + DIR_DB, `${this.id}.json`), this.toString(), 'utf8', (err) => {
            if (err) {
                throw new Error(err.message)
            }
            logger.info(`Saved alarm: ${this.id}`)
        })
    }

    /**
     * Remove the saved copy from fs
     */
    delete() {
        this.destroy()
        
        fs.unlink(path.resolve(__dirname + DIR_DB, `${this.id}.json`), (err) => {
            if (err) {
                throw new Error(err.message)
            }
            logger.info(`Deleted alarm: ${this.id}`)
        })
    }

    /**
     * Destroy all the task cron, release memory
     */
    destroy() {
        if (this.taskAlarmBeep) {
            this.taskAlarmBeep.stop()
            this.taskAlarmBeep.destroy()
        }
        if (this.taskAlarm) {
            this.taskAlarm.stop()
            this.taskAlarm.destroy()
        }
    }

    /**
     * Reset alarm, update next execution date
     */
    reset() {
        if (this.taskAlarmBeep) {
            this.taskAlarmBeep.stop()
        }

        if (this.recurrence) {
            this.date = new Date(parseExpression(this.schedule).next().toString())
            this.save()
        } else {
            this.emit('shouldBeDeleted', this)
        }
    }
}
