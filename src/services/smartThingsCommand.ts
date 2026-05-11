export class Command {
  component?: string;
  capability: string;
  command: string;
  arguments?: unknown[];

  constructor(componentId: string, capability: string, command: string, args?: unknown[]) {
    this.capability = capability;
    this.command = command;
    this.arguments = args;
    if (componentId && componentId !== 'main') {
      this.component = componentId;
    }
  }
}
