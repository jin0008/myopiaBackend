import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    try {
        const count = await prisma.hospital.count();
        console.log(`Total hospitals in DB: ${count}`);
        if (count > 0) {
            const hospitals = await prisma.hospital.findMany({
                take: 3,
                include: {
                    _count: { select: { patient: true } }
                }
            });
            console.log("First 3 hospitals:", JSON.stringify(hospitals, null, 2));
        }
    } catch (e) {
        console.error("Error connecting to DB:", e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
