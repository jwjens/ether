---
feature: users
title: Users & PINs
summary: The people who sign into Ether on a computer, their roles and 4-digit PINs — the same on every computer of the account.
where: Preferences → Users & Security
since: 4.6.62
audience: admin
tour: true
---

# Users & PINs

## What it is

**Users** are the people who sign into Ether on a computer — an admin, a jock, a producer. Each has a **name**, a
**role**, a **colour** and, if you choose, a **4-digit PIN**. They decide who may do what inside Ether. They have nothing to
do with your account sign-in: the account is who owns the stations; users are who works them.

From 4.6.62 **users are the same on every computer of your account.** Add Ryan on one computer and Ryan can sign in on the
others; change a PIN or remove someone, and that reaches every computer too.

## When to use it

- A new person joins the station: add them once, on any computer.
- Someone forgets their PIN: an admin sets a new one.
- Someone leaves: remove them — they are removed everywhere.

## Set it up (Preferences → Users & Security)

1. Open **Preferences → Users & Security**.
2. Press **Add user**. Type the name, pick the role and colour, and (optional) a **4-digit PIN**.
3. To change a PIN: **Change PIN** next to the user. To let someone in without a PIN: **Remove PIN**.
4. To remove someone: **Delete**. The last administrator can never be removed.

## How PINs are kept

A PIN is never stored as typed. It is stored as a slow, salted fingerprint (scrypt), on this computer and on the account,
so it cannot be read back or quickly guessed from a copy. PINs set before 4.6.62 used a faster fingerprint; each one is
upgraded automatically the first time that person enters it — nobody has to set a new PIN.

## The same person on two computers

If a person was added separately on two computers before users synced (two "Steve"s on the same station), Ether keeps
**one** of them on every computer — the same one everywhere — with the role, colour and PIN of whichever was changed
most recently. A Steve on a **different station** is a different person and is left alone. Each merge is written to the
Health log ("users merged").

## Signing in on the web (dashboard, Park page)

Every user **with a PIN** can also sign in on the web pages of the account (app.ether-cast.com, the Park page) with the same
name and PIN. A user without a PIN can't — set one first.

- **Each computer only adds or updates** web sign-ins. A person missing from one computer's list is **not** removed —
  so two computers with different users no longer take turns removing each other's people.
- **Removing a web sign-in takes a real removal:** **Delete** the user, or **Remove PIN**. That computer then tells the
  account to remove that one name. A person who is still on the list with a PIN under the same name (for example, kept by
  the same-person merge) is never removed.
- Users that arrive from another computer appear in **Users & Security** on their own — no need to close and reopen it.

## If someone can't sign in on another computer

- Give it a minute: changes reach the other computers with the next sync.
- Check **Multi-Device Sync** is on (Preferences) on both computers.
- If the person was set up on a computer that has not run 4.6.62 yet, they appear once it has.

## Not in this version (by design)

- Users are per station, as before; a user is not "everywhere on the account" across stations.
- Account sign-in (email + password) is separate and unchanged.

## Related

- **Account sign-in** — who owns the stations.
- **Health Monitor** — the "users merged" and sync lines.
