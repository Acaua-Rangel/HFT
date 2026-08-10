export class TimeProvider {
    private static virtualTime: number | null = null;
    
    public static now(): number {
        return this.virtualTime !== null ? this.virtualTime : Date.now();
    }
    
    public static isVirtual(): boolean {
        return this.virtualTime !== null;
    }
    
    public static setVirtualTime(time: number) {
        this.virtualTime = time;
    }
    
    public static clearVirtualTime() {
        this.virtualTime = null;
    }
}
