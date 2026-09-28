# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
#  ربات رزرو غذا — ایمیج production
#
#  چهار مرحله دارد تا ایمیج نهایی فقط چیزی را داشته باشد که برای اجرا لازم است:
#  کد کامپایل‌شده و وابستگی‌های runtime. کامپایلر، تست‌ها و ابزارهای بیلد
#  در لایه‌های میانی می‌مانند.
#
#  چرا `slim` و نه `alpine`: بهتر-sqlite3 یک ماژول native است. روی glibc
#  باینری آمادهٔ رسمی برای linux-x64 منتشر می‌شود و نصب در چند ثانیه تمام
#  می‌شود؛ روی musl چنین باینری‌ای وجود ندارد و node-gyp باید کل ماژول را از
#  صفر کامپایل کند. تجربه نشان داد این کامپایل روی Alpine بیش از پانزده دقیقه
#  طول می‌کشد و در شبکه‌های محدود (که دانلود هدرهای Node را قطع می‌کنند)
#  می‌تواند کاملاً متوقف شود.
#
#  ابزارهای کامپایل با این حال نصب می‌شوند: اگر دسترسی به GitHub برای گرفتن
#  باینری آماده ممکن نباشد، npm به کامپایل از سورس برمی‌گردد و باید موفق شود.
#
#  هر چهار مرحله یک پایه دارند تا ماژول native کامپایل‌شده در مرحلهٔ بیلد با
#  نسخهٔ Node و libc زمان اجرا هم‌خوان باشد.
# ─────────────────────────────────────────────────────────────────────────────

# ── مرحلهٔ ۱: وابستگی‌ها ─────────────────────────────────────────────────────
FROM node:26-slim AS dependencies

WORKDIR /app

# فقط برای مسیر پشتیبان (کامپایل از سورس). در حالت معمول استفاده نمی‌شوند.
RUN apt-get update
RUN apt-get install -y --no-install-recommends python3 make g++
RUN rm -rf /var/lib/apt/lists/*

# فقط مانیفست‌ها کپی می‌شوند تا لایهٔ نصب وابستگی تا وقتی خود وابستگی‌ها تغییر
# نکرده‌اند کش شود. کپی‌کردن کل سورس اینجا یعنی هر تغییر در یک فایل، نصب مجدد
# کامل را بی‌دلیل دوباره اجرا می‌کند.
COPY package.json package-lock.json ./

# `npm ci` به‌جای `npm install`: دقیقاً همان درخت package-lock را می‌سازد و اگر
# مانیفست با قفل هم‌خوان نباشد، بیلد را شکست می‌دهد.
RUN npm ci


# ── مرحلهٔ ۲: بیلد ───────────────────────────────────────────────────────────
FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build


# ── مرحلهٔ ۳: وابستگی‌های production ────────────────────────────────────────
# حذف devDependencies در همین درخت، به‌جای نصب دوباره از صفر.
FROM dependencies AS production-dependencies

RUN npm prune --omit=dev


# ── مرحلهٔ ۴: اجرا ───────────────────────────────────────────────────────────
FROM node:26-slim AS runtime

# tini به‌عنوان PID ۱: سیگنال‌ها را به Node می‌رساند و پروسه‌های یتیم را جمع
# می‌کند. بدون آن، SIGTERM ممکن است به فرایند نرسد و کانتینر با SIGKILL و
# بدون checkpoint نهایی WAL کشته شود.
RUN apt-get update
RUN apt-get install -y --no-install-recommends tini
RUN rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/bot.db

WORKDIR /app

# ترتیب کپی از کم‌تغییرترین به پرتغییرترین است تا کش لایه‌ها بیشترین استفاده را ببرد.
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# پوشهٔ دیتابیس با مالکیت کاربر node ساخته می‌شود. در عمل والیوم روی آن سوار
# می‌شود و داکر مالکیت ایمیج را برای والیوم تازه به ارث می‌برد.
RUN mkdir -p /app/data && chown -R node:node /app/data

# اجرا با کاربر غیر root. اگر مهاجم راهی به فرایند پیدا کند، داخل کانتینر
# دسترسی root ندارد.
USER node

EXPOSE 3000

# بدون curl یا wget: خود Node به‌عنوان probe استفاده می‌شود تا ایمیج یک باینری
# اضافه نداشته باشد. start-period به ربات فرصت می‌دهد تا دیتابیس را باز کند.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM همان چیزی است که هندلر خاموشی در main.ts منتظرش است.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
