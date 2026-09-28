import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthRequest, parse, SessionGuard } from './common';
import { CrmService } from './crm.service';
import { z } from 'zod';
import { PrismaService } from './prisma.service';

@Controller('api/v1')
@UseGuards(SessionGuard)
export class CrmController {
  constructor(private crm: CrmService) {}
  @Get('leads') listLeads(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.listLeads(r.actor, q); }
  @Post('leads') createLead(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createLead(r.actor, b); }
  @Get('leads/:id') getLead(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.getLead(r.actor, id); }
  @Patch('leads/:id') updateLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.updateLead(r.actor, id, b); }
  @Get('leads/:id/timeline') leadTimeline(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.leadTimeline(r.actor, id); }
  @Get('leads/:id/duplicate-candidates') leadDuplicates(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.leadDuplicates(r.actor, id); }
  @Post('leads/:id/assign') assignLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.assignLead(r.actor, id, b); }
  @Post('leads/:id/accept') acceptLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.acceptLead(r.actor, id, b); }
  @Post('leads/:id/return') returnLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.returnLead(r.actor, id, b); }
  @Post('leads/:id/invalidate') invalidateLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.invalidateLead(r.actor, id, b); }
  @Post('leads/:id/qualify') qualifyLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.qualifyLead(r.actor, id, b); }
  @Post('leads/:id/request-conversion') requestConversion(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.requestConversion(r.actor, id, b); }
  @Post('leads/:id/review-conversion') reviewConversion(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.reviewConversion(r.actor, id, b); }
  @Post('leads/:id/convert') convertLead(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown, @Headers('idempotency-key') key?: string) { return this.crm.convertLead(r.actor, id, b, key); }

  @Get('customers/duplicate-candidates') customerDuplicates(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.customerDuplicates(r.actor, q); }
  @Get('customers') listCustomers(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.listCustomers(r.actor, q); }
  @Post('customers') createCustomer(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createCustomer(r.actor, b); }
  @Get('customers/:id') getCustomer(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.getCustomer(r.actor, id); }
  @Patch('customers/:id') updateCustomer(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.updateCustomer(r.actor, id, b); }
  @Post('customers/:id/transfer') transferCustomer(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.transferCustomer(r.actor, id, b); }
  @Get('customers/:id/contacts') listContacts(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.listContacts(r.actor, id); }
  @Post('customers/:id/contacts') createContact(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.createContact(r.actor, id, b); }
  @Get('contacts/:id') getContact(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.getContact(r.actor, id); }
  @Patch('contacts/:id') updateContact(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.updateContact(r.actor, id, b); }

  @Get('opportunities') listOpportunities(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.listOpportunities(r.actor, q); }
  @Post('opportunities') createOpportunity(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createOpportunity(r.actor, b); }
  @Get('opportunities/:id') getOpportunity(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.getOpportunity(r.actor, id); }
  @Patch('opportunities/:id') updateOpportunity(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.updateOpportunity(r.actor, id, b); }
  @Post('opportunities/:id/advance') advanceOpportunity(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.advanceOpportunity(r.actor, id, b); }
  @Post('opportunities/:id/close-won') winOpportunity(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.winOpportunity(r.actor, id, b); }
  @Post('opportunities/:id/close-lost') loseOpportunity(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.loseOpportunity(r.actor, id, b); }

  @Get('follow-ups') listFollowUps(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.listFollowUps(r.actor, q); }
  @Post('follow-ups') createFollowUp(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createFollowUp(r.actor, b); }
  @Get('tasks') listTasks(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.listTasks(r.actor, q); }
  @Post('tasks/:id/complete') completeTask(@Req() r: AuthRequest, @Param('id') id: string) { return this.crm.completeTask(r.actor, id); }
  @Get('dashboard') dashboard(@Req() r: AuthRequest) { return this.crm.dashboard(r.actor); }
  @Get('reports/leads') leadReport(@Req() r: AuthRequest, @Query() q: Record<string, unknown>) { return this.crm.leadReport(r.actor, q); }

  @Get('admin/users') adminUsers(@Req() r: AuthRequest) { return this.crm.adminUsers(r.actor); }
  @Post('admin/users') createUser(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createUser(r.actor, b); }
  @Patch('admin/users/:id/membership') updateMembership(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.updateMembership(r.actor, id, b); }
  @Patch('admin/users/:id/active') setUserActive(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { const v = parse(z.object({ active: z.boolean() }), b); return this.crm.setUserActive(r.actor, id, v.active); }
  @Post('admin/org-units') createOrg(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createOrg(r.actor, b); }
  @Get('admin/lead-pools') listPools(@Req() r: AuthRequest) { return this.crm.listPools(r.actor); }
  @Post('admin/lead-pools') createPool(@Req() r: AuthRequest, @Body() b: unknown) { return this.crm.createPool(r.actor, b); }
  @Patch('admin/lead-pools/:id') updatePool(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.crm.updatePool(r.actor, id, b); }
  @Post('admin/lead-pools/:poolId/assign/:leadId') autoAssign(@Req() r: AuthRequest, @Param('poolId') poolId: string, @Param('leadId') leadId: string, @Body() b: unknown) { return this.crm.autoAssign(r.actor, poolId, leadId, b); }
}

@Controller('api/v1')
export class HealthController {
  constructor(private db: PrismaService) {}
  @Get('health') async health() { await this.db.$queryRaw`SELECT 1`; return { ok: true, database: 'ready' }; }
}
