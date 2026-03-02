/**
 * Mayor Routes — Public Read-Only API
 */

import { Hono } from 'hono'
import { MayorElectionModel, MayorTermModel, ImpeachmentModel } from '../db/mayor.schema'

export const mayorRouter = new Hono()

// GET /mayor/current — active term
mayorRouter.get('/current', async (c) => {
    const term = await MayorTermModel.findOne({ status: 'active' }).lean()
    return c.json(term ?? null)
})

// GET /mayor/election — active election
mayorRouter.get('/election', async (c) => {
    const election = await MayorElectionModel.findOne({
        phase: { $in: ['campaign', 'voting'] }
    }).lean()
    return c.json(election ?? null)
})

// GET /mayor/history — past terms
mayorRouter.get('/history', async (c) => {
    const terms = await MayorTermModel
        .find({ status: { $ne: 'active' } })
        .sort({ startedAt: -1 })
        .limit(10)
        .lean()
    return c.json(terms)
})

// GET /mayor/impeachment — active impeachment
mayorRouter.get('/impeachment', async (c) => {
    const impeachment = await ImpeachmentModel.findOne({
        status: { $in: ['collecting_signatures', 'voting'] }
    }).lean()
    return c.json(impeachment ?? null)
})
