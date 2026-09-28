import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthRequest, SessionGuard } from './common';
import { CsmService } from './csm.service';

@Controller('api/v1/csm') @UseGuards(SessionGuard)
export class CsmController {
  constructor(private csm: CsmService) {}
  @Post('customers/:id/assign') assign(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.csm.assignOwner(r.actor, id, b); }
  @Get('plans') plans(@Req() r: AuthRequest) { return this.csm.listPlans(r.actor); }
  @Post('plans') createPlan(@Req() r: AuthRequest, @Body() b: unknown) { return this.csm.createPlan(r.actor, b); }
  @Get('plans/:id') plan(@Req() r: AuthRequest, @Param('id') id: string) { return this.csm.getPlan(r.actor, id); }
  @Post('plans/:id/tasks') createTask(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.csm.createTask(r.actor, id, b); }
  @Post('tasks/:id/submit') submit(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.csm.submitTask(r.actor, id, b); }
  @Post('tasks/:id/review') review(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.csm.reviewTask(r.actor, id, b); }
  @Get('risks') risks(@Req() r: AuthRequest) { return this.csm.listRisks(r.actor); }
  @Post('risks') createRisk(@Req() r: AuthRequest, @Body() b: unknown) { return this.csm.createRisk(r.actor, b); }
  @Post('risks/:id/close') closeRisk(@Req() r: AuthRequest, @Param('id') id: string, @Body() b: unknown) { return this.csm.closeRisk(r.actor, id, b); }
  @Post('renewals') createRenewal(@Req() r: AuthRequest, @Body() b: unknown) { return this.csm.createRenewal(r.actor, b); }
  @Get('report') report(@Req() r: AuthRequest) { return this.csm.report(r.actor); }
}
